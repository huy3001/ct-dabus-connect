<p align="center">
  <a href="https://commercetools.com/">
    <img alt="commercetools logo" src="https://unpkg.com/@commercetools-frontend/assets/logos/commercetools_primary-logo_horizontal_RGB.png">
  </a></br>
  <b>Connect Application Starter in TypeScript</b>
</p>

This is the `starter-typescript` template to develop [connect applications](https://marketplace.commercetools.com/) in TypeScript.

## Dabus order sync

Stateless two-way order sync, as specified in [AGENTS.md](./AGENTS.md).

- **Outbound (`event/`)**: a commercetools Subscription (`OrderCreated`, `OrderStateChanged`) pushes to `POST /event`. The controller decodes the Pub/Sub message, skips orders whose `lastUpdatedBy` is `dabus` (clearing the flag), maps the order with `src/mappers/orderMapper.ts`, creates or updates it in Dabus through the generated client, and records `dabusSyncStatus` (`SYNCED` or `FAILED`) on the order. Transient failures answer 500 so Pub/Sub retries; unmappable orders are marked `FAILED` and acknowledged.
- **Inbound (`service/`)**: `POST /service/webhooks/dabus` with header `x-dabus-webhook-secret` and body `{"order_number": "...", "status": "pending|processing|complete|canceled|..."}`. The payload shape is an assumption: `swagger.yml` defines no webhook. `pending`, `processing`, `complete` and `canceled` change the order state and tag `lastUpdatedBy: dabus`; other statuses write nothing.
- **Lifecycle**: `postDeploy` creates the `dabus-order-sync-metadata` Order custom type and, in `event/`, the `dabus-order-sync-subscription`. `preUndeploy` deletes only the subscription.
- **Client**: `event/src/generated/dabus-client/` is generated with swagger-codegen (command in AGENTS.md). It uses camelCase models and ignores the OAuth scheme, so `src/clients/dabus.ts` converts keys to snake_case and adds the bearer token.

Configuration is in `connect.yaml`. `DABUS_BASE_URL` includes the version, sandbox and system code. Plain HTTP is accepted only for loopback hosts such as the local mock.

## Local Dabus API mock

With Node.js 24.18 or later, run `npm install` and then `npm run mock:dabus`
from this directory. The mock listens only on `http://127.0.0.1:4000` and
uses the server-variable defaults from `swagger.yml`; for example,
`GET /v1/commercetools/test-b2b-project/orders`. Send a dummy bearer token
for operations requiring OAuth.

This is an OpenAPI-generated mock, not Dabus: responses are synthetic, writes
are not persisted, and OAuth credentials are not verified. Stop it with
Ctrl+C. The Dabus client accepts this HTTP URL because it is a loopback host.

## Instructions

Use `create-connect-app` cli with `starter-typescript` as `template` value to download this template repository to build the integration application , folder structure needs to be followed to ensure certification & deployment from commercetools connect team as stated [here](https://github.com/commercetools/connect-application-kit#readme) 

## Architecture principles for building an connect application 

* Connector solution should be lightweight in nature
* Connector solutions should follow test driven development. Unit , Integration (& E2E) tests should be included and successfully passed to be used
* No hardcoding of customer related config. If needed, values in an environment file which should not be maintained in repository
* Connector solution should be supported with detailed documentation
* Connectors should be point to point in nature, currently doesnt support any persistence capabilities apart from in memory persistence
* Connector solution should use open source technologies, although connector itself can be private for specific customer(s)
* Code should not contain console.log statements, use [the included logger](https://github.com/commercetools/merchant-center-application-kit/tree/main/packages-backend/loggers#readme) instead.
