# AI Agent Implementation Guideline: commercetools Connect ↔ Dabus 2-Way Order Sync & Jobs Proxy

## 1. Project Context & Architecture
You are implementing a **stateless, bidirectional (2-way) Order synchronization application and Scheduled Jobs observer proxy** built on the **commercetools Connect TypeScript Starter Template** to integrate **commercetools** with **Dabus** and deploy directly inside the **commercetools Merchant Center**.

* **Descriptor (`connect.yaml`):** Defines a multi-application Connect bundle containing an `event` application (outbound) and a `service` application (inbound webhooks + Merchant Center jobs proxy), plus shared configuration variables (`standardConfiguration` and `securedConfiguration`).
* **Outbound Flow (commercetools → Dabus):** Managed by the **`event/`** application. commercetools Connect automatically provisions a messaging Subscription (`OrderCreated`, `OrderStateChanged`) and pushes events via HTTP `POST` to the `event` Express endpoint. The controller checks for infinite loops and invokes the generated Dabus TypeScript client.
* **Inbound Flow (Dabus → commercetools):** Managed by the **`service/`** application. Connect exposes a public HTTPS endpoint (`POST /webhooks/dabus`) where Dabus pushes fulfillment/status updates. The controller updates the commercetools order using `@commercetools/platform-sdk` and tags `lastUpdatedBy: 'dabus'`.
* **Scheduled Jobs Observer Proxy (`GET /api/dabus/jobs`):** Exposed by the **`service/`** application for our standalone Merchant Center Custom Application (`mc-dabus-jobs`). Because Dabus has no native `/jobs` endpoint and no data may be stored on commercetools' server side, `service` dynamically queries Dabus repository search endpoints (`updated_at` / `created_at` timestamps) for **Past Jobs** and computes **Upcoming Jobs** in memory via `cron-parser`.
* **Lifecycle Automation (`postDeploy` / `preUndeploy`):** Automated scripts inside `event/src/connector/` and `service/src/connector/` automatically provision and clean up the commercetools Order Subscription and Custom Type (`lastUpdatedBy`, `dabusSyncStatus`) when a user installs or uninstalls the app in Merchant Center.
* **State Management:** Completely **stateless** (no external database or commercetools Custom Objects). All order sync metadata and loop-prevention flags live on commercetools `Order` Custom Fields and `externalId`.

---

## 2. Tech Stack & Tooling Constraints
* **Platform:** commercetools Connect (`connect.yaml` v1 schema, Node.js `20.x`, TypeScript strict mode).
* **HTTP Framework:** Express.js (standard in `connect-application-typescript-template`).
* **Dabus SDK Generation:** Do NOT hand-write HTTP requests or DTOs for Dabus. Always use the auto-generated TypeScript client generated from `swagger.yml` (`OpenAPI 3.0.0`).
* **commercetools SDK:** Official `@commercetools/platform-sdk` and `@commercetools/sdk-client-v2`.
* **Cron & Auth Utilities (`service/`):** `cron-parser` for upcoming schedule calculation and `@commercetools-backend/express` (`createSessionAuthVerifier`) for verifying Merchant Center `/proxy/forward-to` JWTs.
* **Local Development:** Run `event` and `service` apps locally via `npm run start:dev` on distinct ports (e.g., `8081` and `8082`), preloading `dotenv/config` at line 1 of entrypoints.

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
│       ├── index.ts                           # Express server entrypoint (import 'dotenv/config' on line 1)
│       ├── app.ts                             # Express middleware (parses application/json & text/plain)
│       ├── generated/
│       │   └── dabus-client/                  # Auto-generated Dabus SDK (DO NOT EDIT MANUALLY)
│       ├── clients/
│       │   ├── dabus.ts                       # Singleton Dabus API client & AWS Cognito OAuth2 token cache
│       │   └── commercetools.ts               # commercetools apiRoot factory
│       ├── controllers/
│       │   └── event.controller.ts            # Handles AWS SNS & GCP Pub/Sub HTTP POST messages
│       ├── mappers/
│       │   └── orderMapper.ts                 # Pure functions: commercetools Order -> Dabus Order DTO
│       ├── sync/
│       │   └── order-sync.ts                  # Upsert logic (GET -> POST/PUT) & loop prevention
│       └── connector/
│           ├── actions.ts                     # Auto-detects AWS SNS vs GCP Pub/Sub subscriptions
│           ├── post-deploy.ts                 # Creates Order Subscription & Custom Type on install
│           └── pre-undeploy.ts                # Deletes Order Subscription on uninstall
└── service/                                   # Inbound App & Jobs Proxy: Dabus <-> commercetools
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts                           # Express server entrypoint (import 'dotenv/config' on line 1)
        ├── generated/
        │   └── dabus-client/                  # Shared generated Dabus SDK & models
        ├── clients/
        │   ├── dabus.ts                       # Singleton Dabus API client & Cognito token manager
        │   └── commercetools.ts               # commercetools apiRoot factory
        ├── routes/
        │   └── service.route.ts               # Exposes POST /webhooks/dabus and GET /api/dabus/jobs
        ├── controllers/
        │   ├── webhook.controller.ts          # Validates Dabus webhook & updates commercetools Order
        │   └── jobs.controller.ts             # Serves GET /api/dabus/jobs for Merchant Center UI
        ├── services/
        │   └── dabusJobs.service.ts           # Queries Dabus entity timestamps & computes cron schedules
        └── connector/
            ├── post-deploy.ts                 # Ensures Custom Type exists on install
            └── pre-undeploy.ts                # Cleanup hook on uninstall
```

---

## 4. Implementation Rules & Guardrails

### Rule 1: `connect.yaml` Configuration Standard
* Define both `event` and `service` entries under `deployAs:` in `connect.yaml`.
* Declare non-sensitive parameters (`DABUS_BASE_URL`, `DABUS_AUTH_URL`, `DABUS_ORDER_ORIGIN`, `CTP_PROJECT_KEY`, `CTP_REGION`, and optional `DABUS_JOB_SCHEDULES_JSON` on `service`) under `standardConfiguration`.
* Declare sensitive credentials (`DABUS_CLIENT_ID`, `DABUS_CLIENT_SECRET`, `CTP_CLIENT_ID`, `CTP_CLIENT_SECRET`, `DABUS_WEBHOOK_SECRET`) under `securedConfiguration`.
* Do NOT declare `CONNECT_AWS_TOPIC_ARN`, `CONNECT_GCP_TOPIC_NAME`, or `CONNECT_GCP_PROJECT_ID` in `connect.yaml`—Connect injects them automatically at runtime.
* Configure `postDeploy: npm install && npm run build && npm run connector:post-deploy` and `preUndeploy: npm install && npm run build && npm run connector:pre-undeploy` for `event`.

### Rule 2: Dabus Client Generation & Cognito Auth
* Never manually modify files inside `generated/dabus-client/`.
* Authenticate against Dabus's AWS Cognito `/oauth2/token` endpoint using `application/x-www-form-urlencoded` (`grant_type=client_credentials`) and a `Basic` auth header (`DABUS_CLIENT_ID:DABUS_CLIENT_SECRET`), caching the bearer token until 60s before expiry. Support `DABUS_AUTH_URL=local-bypass` for local dev.
* Note Dabus OpenAPI paths use singular resource names for single-item operations: `GET /order/{order_number}`, `POST /order`, `PUT /order/{order_number}`.

### Rule 3: Infinite Loop Prevention & Retry Behavior (Mandatory)
* **In `service/src/controllers/webhook.controller.ts` (Dabus → commercetools):** Every order update call to `apiRoot.orders().withId(...).post(...)` MUST include `{ action: 'setCustomField', name: 'lastUpdatedBy', value: 'dabus' }` (or `setCustomType` if the order has no custom type yet).
* **In `event/src/sync/order-sync.ts` (commercetools → Dabus):**
  * Skip ONLY when `order.custom?.fields?.lastUpdatedBy === 'dabus'`.
  * Do NOT skip when `dabusSyncStatus === 'FAILED'`—allow `OrderStateChanged` events to retry failed orders and update `dabusSyncStatus` to `'SYNCED'` on success.
  * Fall back to `order.id` if `order.orderNumber` is undefined.

### Rule 4: Multi-Cloud Notification Handling (`event` App)
* `event/src/app.ts` MUST parse both `application/json` and `text/plain` (`express.json({ type: ['application/json', 'text/plain'] })`) because AWS SNS delivers JSON with `Content-Type: text/plain`.
* `event/src/controllers/event.controller.ts` MUST handle:
  1. AWS SNS `SubscriptionConfirmation` (`GET SubscribeURL` -> HTTP `200`).
  2. AWS SNS `Notification` (`JSON.parse(request.body.Message)`).
  3. GCP Pub/Sub push messages (`Buffer.from(request.body.message.data, 'base64').toString('utf-8')`).
* Acknowledge valid or skipped messages with HTTP `204`; return HTTP `500` only on transient failures so the queue retries.

### Rule 5: `postDeploy` & `preUndeploy` Lifecycle Automation
* **`ensureOrderSyncCustomType`:** Idempotently creates or updates Custom Type `dabus-order-sync-metadata` on `order` with fields `lastUpdatedBy` (`String`) and `dabusSyncStatus` (`String`).
* **`createOrderSubscription`:** Auto-detects `CONNECT_AWS_TOPIC_ARN` (creates `SNS` subscription with `authenticationMode: 'IAM'`) vs. `CONNECT_GCP_TOPIC_NAME` + `CONNECT_GCP_PROJECT_ID` (creates `GoogleCloudPubSub` subscription, skipping if `local-dev-project`).
* **`pre-undeploy.ts`:** Deletes `dabus-order-sync-subscription` by key/version without deleting the Custom Type.

### Rule 6: Stateless Scheduled Jobs Proxy (`GET /api/dabus/jobs` in `service/`)
* **Zero Storage:** Never persist job history in commercetools Custom Objects or a database.
* **Authentication:** Protect `GET /api/dabus/jobs` with `@commercetools-backend/express` (`createSessionAuthVerifier`) to validate Merchant Center `/proxy/forward-to` session tokens (allow `SKIP_MC_AUTH=true` for local `curl` testing).
* **Past Jobs Derivation:** Query Dabus in parallel (`Promise.allSettled`, `pageNumber: 1, pageSize: 10`) across:
  * `GET /products` -> `"Product Master Sync"`
  * `GET /inventory-source/items` -> `"Inventory Stock Sync"`
  * `GET /orders` -> `"Order Sync"`
  * `GET /shipments` -> `"Shipment Sync"`
  Extract the latest `updated_at` / `created_at` timestamp and item count for each entity. If an individual call fails, mark that entry `status: 'FAILED'` with `errorMessage` without failing the whole endpoint.
* **Upcoming Jobs Computation:** Parse `process.env.DABUS_JOB_SCHEDULES_JSON` (with sensible defaults such as Inventory `*/15 * * * *`, Products `0 * * * *`, Shipments `*/30 * * * *`) and calculate `nextRunAt` via `cron-parser`.
* **Response Contract (`DabusJobsResponse`):**
  ```typescript
  export interface PastJobItem {
    id: string;
    jobName: string;
    entityType: string;
    lastRunAt: string | null;
    recordsObserved: number;
    status: 'SUCCESS' | 'FAILED' | 'NO_DATA';
    errorMessage?: string;
  }

  export interface UpcomingJobItem {
    id: string;
    jobName: string;
    cronExpression: string;
    scheduleLabel: string;
    nextRunAt: string;
    enabled: boolean;
  }

  export interface DabusJobsResponse {
    fetchedAt: string;
    pastJobs: PastJobItem[];
    upcomingJobs: UpcomingJobItem[];
  }
  ```

---

## 5. Step-by-Step Execution Plan for the Agent
1. **Verify Generated Dabus SDK & Auth:** Confirm `generated/dabus-client/` and Cognito token caching work in both `event/` and `service/`.
2. **Audit `event/` App:** Verify AWS SNS + GCP Pub/Sub support in `app.ts`, `event.controller.ts`, `connector/actions.ts`, and `FAILED` order retry logic in `sync/order-sync.ts`.
3. **Implement `GET /api/dabus/jobs` in `service/`:** Add `cron-parser` and `@commercetools-backend/express`, build `services/dabusJobs.service.ts` and `controllers/jobs.controller.ts`, and wire the route in `routes/service.route.ts`.
4. **Update `connect.yaml` & Tests:** Add optional `DABUS_JOB_SCHEDULES_JSON` to `service` in `connect.yaml`, write unit tests, and verify `npm run build` passes in both `event/` and `service/`.
