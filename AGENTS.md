# AI Agent Implementation Guideline: commercetools Connect ↔ Dabus 2-Way Order Sync

## 1. Project Context & Architecture
You are implementing a **stateless, bidirectional (2-way) Order synchronization application** built on the **commercetools Connect TypeScript Starter Template** to integrate **commercetools** with **Dabus** and deploy directly inside the **commercetools Merchant Center**.

* **Descriptor (`connect.yaml`):** Defines a multi-application Connect bundle containing an `event` application (outbound) and a `service` application (inbound), plus shared configuration variables (`standardConfiguration` and `securedConfiguration`).
* **Outbound Flow (commercetools → Dabus):** Managed by the **`event/`** application. commercetools Connect automatically provisions a Google Cloud Pub/Sub Subscription (`OrderCreated`, `OrderStateChanged`) and pushes events via HTTP `POST` to the `event` Express endpoint. The controller checks for infinite loops and invokes the generated Dabus TypeScript client.
* **Inbound Flow (Dabus → commercetools):** Managed by the **`service/`** application. Connect exposes a public HTTPS endpoint (`POST /webhooks/dabus`) where Dabus pushes fulfillment/status updates. The controller updates the commercetools order using `@commercetools/platform-sdk` and tags `lastUpdatedBy: 'dabus'`.
* **Lifecycle Automation (`postDeploy` / `preUndeploy`):** Automated scripts inside `event/src/connector/` and `service/src/connector/` automatically provision and clean up the commercetools Order Subscription and Custom Type (`lastUpdatedBy`, `dabusSyncStatus`) when a user installs or uninstalls the app in Merchant Center.
* **State Management:** Completely **stateless** (no external database). All sync metadata and loop-prevention flags live on commercetools `Order` Custom Fields and `externalId`.

---

## 2. Tech Stack & Tooling Constraints
* **Platform:** commercetools Connect (`connect.yaml` v1 schema, Node.js `20.x`, TypeScript strict mode).
* **HTTP Framework:** Express.js (standard in `connect-application-typescript-template`).
* **Dabus SDK Generation:** Do NOT hand-write HTTP requests or DTOs for Dabus. Always use the auto-generated `typescript-fetch` client generated from `swagger.yml` (`OpenAPI 3.0.0`).
* **commercetools SDK:** Official `@commercetools/platform-sdk` and `@commercetools/sdk-client-v2`.
* **Local Development:** Run `event` and `service` apps locally via `npm run dev` on distinct ports (e.g., `8080` and `8081`), using ngrok/Cloudflare Tunnel if testing live webhooks from external systems.

---

## 3. Directory Structure Standard (commercetools Connect)
Follow the standard multi-application layout expected by commercetools Connect:

```text
├── connect.yaml                               # Connect deployment descriptor (event + service apps)
├── swagger.yml                                # OpenAPI 3.0.0 spec for Dabus
├── package.json                               # Root workspace / scripts
├── event/                                     # Outbound App: commercetools -> Dabus
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts                           # Express server entrypoint
│       ├── generated/
│       │   └── dabus-client/                  # Auto-generated Dabus SDK (DO NOT EDIT MANUALLY)
│       ├── clients/
│       │   ├── dabus.ts                       # Singleton Dabus API client initialization
│       │   └── commercetools.ts               # commercetools apiRoot factory
│       ├── controllers/
│       │   └── event.controller.ts            # Receives GCP Pub/Sub HTTP POST push messages
│       ├── mappers/
│       │   └── orderMapper.ts                 # Pure functions: commercetools Order -> Dabus Order DTO
│       └── connector/
│           ├── post-deploy.ts                 # Creates Order Subscription & Custom Type on install
│           └── pre-undeploy.ts                # Deletes Order Subscription on uninstall
└── service/                                   # Inbound App: Dabus -> commercetools
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts                           # Express server entrypoint
        ├── generated/
        │   └── dabus-client/                  # Shared generated Dabus models for webhook payloads
        ├── clients/
        │   └── commercetools.ts               # commercetools apiRoot factory
        ├── routes/
        │   └── service.route.ts               # Exposes POST /webhooks/dabus
        ├── controllers/
        │   └── webhook.controller.ts          # Validates payload & updates commercetools Order
        └── connector/
            ├── post-deploy.ts                 # Ensures Custom Type exists & verifies Dabus connectivity
            └── pre-undeploy.ts                # Cleanup hook on uninstall
```

---

## 4. Implementation Rules & Guardrails

### Rule 1: `connect.yaml` Configuration Standard
* Define both `event` and `service` entries under `deployAs:` in `connect.yaml`.
* Declare non-sensitive parameters (`DABUS_BASE_URL`, `CTP_PROJECT_KEY`, `CTP_REGION`) under `standardConfiguration` and sensitive credentials (`DABUS_ACCESS_TOKEN` / `DABUS_CLIENT_SECRET`, `CTP_CLIENT_ID`, `CTP_CLIENT_SECRET`, `DABUS_WEBHOOK_SECRET`) under `securedConfiguration`.
* For the `event` application, configure `postDeploy: npm run connector:post-deploy` and `preUndeploy: npm run connector:pre-undeploy` inside `event/package.json` so Connect executes lifecycle hooks automatically.

### Rule 2: Dabus Client Generation & Usage
* Never manually modify files inside `generated/dabus-client/`.
* When `swagger.yml` updates, regenerate the TypeScript Fetch client using Docker (no local Java required) and sync it into `event/src/generated/dabus-client/` (and `service/src/generated/dabus-client/` if shared):
  ```bash
  docker run --rm -v "${PWD}:/local" swaggerapi/swagger-codegen-cli-v3 generate     -i /local/swagger.yml     -l typescript-fetch     -o /local/event/src/generated/dabus-client
  ```
* Inspect `generated/dabus-client/configuration.ts` and initialize `Configuration` at module scope in `clients/dabus.ts` using environment variables injected by Connect (`process.env.DABUS_BASE_URL`, `process.env.DABUS_ACCESS_TOKEN`).

### Rule 3: Infinite Loop Prevention (Mandatory)
Every sync handler must enforce loop prevention via commercetools Custom Fields:
* **In `service/src/controllers/webhook.controller.ts` (Dabus → commercetools):** Every order update call to `apiRoot.orders().withId(...).post(...)` MUST include the update action `{ action: 'setCustomField', name: 'lastUpdatedBy', value: 'dabus' }`.
* **In `event/src/controllers/event.controller.ts` (commercetools → Dabus):** Decode the incoming Pub/Sub message (`Buffer.from(req.body.message.data, 'base64').toString('utf-8')`), inspect `order.custom?.fields?.lastUpdatedBy`, and if it equals `'dabus'`, return HTTP `204 No Content` immediately without calling Dabus.

### Rule 4: GCP Pub/Sub Push Message Handling (`event` App)
* commercetools Connect delivers subscription events via Google Cloud Pub/Sub HTTP push (`req.body.message.data` encoded in Base64).
* Always acknowledge valid or intentionally skipped messages with HTTP `200` or `204` so Pub/Sub does not endlessly redeliver them.
* Return HTTP `500` only on transient network/Dabus API failures so Pub/Sub triggers automatic exponential backoff retries.
* Because `OrderStateChanged` messages only carry `resource.id` rather than the full `Order` object, fetch the latest order via `apiRoot.orders().withId({ ID: messageBody.resource.id }).get().execute()` whenever `messageBody.order` is absent.

### Rule 5: `postDeploy` & `preUndeploy` Lifecycle Automation
* **`post-deploy.ts` (Idempotent Setup):**
  1. Check if the commercetools Custom Type (e.g., `key: 'dabus-order-sync-metadata'`) for resource type `order` exists; if not, create it with fields `lastUpdatedBy` (`String`) and `dabusSyncStatus` (`String`). If it exists, ensure both field definitions are present.
  2. In `event/src/connector/post-deploy.ts`, read `CONNECT_GCP_TOPIC_NAME` and `CONNECT_GCP_PROJECT_ID` (automatically injected by commercetools Connect during deployment) and upsert the commercetools `Subscription` (`key: 'dabus-order-sync-subscription'`) listening to `OrderCreated` and `OrderStateChanged`.
* **`pre-undeploy.ts` (Clean Teardown):**
  1. Delete the `Subscription` (`key: 'dabus-order-sync-subscription'`) by key/version so commercetools stops publishing to removed infrastructure. Do NOT delete the Custom Type automatically to avoid data loss on existing orders.

### Rule 6: Security & Inbound Webhook Verification
* In `service/src/controllers/webhook.controller.ts`, validate incoming Dabus webhook requests (e.g., verifying a shared secret header or HMAC signature against `process.env.DABUS_WEBHOOK_SECRET`) before mutating commercetools orders.
* Always fetch the current `order.version` from commercetools before executing `.post({ body: { version, actions } })` to prevent `ConcurrentModification` errors.

---

## 5. Step-by-Step Execution Plan for the Agent
When scaffolding or implementing this Connect application, execute in this exact order:
1. **Verify Generated Dabus SDK:** Confirm `event/src/generated/dabus-client/` exists and inspect its exported API classes (`OrdersApi`) and Order request/response models.
2. **Configure `connect.yaml`:** Define `event` and `service` modules, environment variables (`standardConfiguration` & `securedConfiguration`), and npm scripts.
3. **Implement Lifecycle Hooks (`connector/post-deploy.ts` & `pre-undeploy.ts`):** Automate creation of the `dabus-order-sync-metadata` Custom Type and the GCP Pub/Sub Order Subscription.
4. **Implement Outbound App (`event/`):** Build `clients/dabus.ts`, `mappers/orderMapper.ts`, and `controllers/event.controller.ts` (Base64 Pub/Sub decoding, `lastUpdatedBy === 'dabus'` loop guard, Dabus API call, and updating `dabusSyncStatus: 'SYNCED'`).
5. **Implement Inbound App (`service/`):** Build `routes/service.route.ts` (`POST /webhooks/dabus`) and `controllers/webhook.controller.ts` (webhook auth check, version lookup, commercetools order update with `lastUpdatedBy: 'dabus'`).
6. **Verify Build & Local Run:** Run `npm run build` across both `event` and `service` workspaces and test local HTTP requests against both Express servers.
