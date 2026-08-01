# platform-deploy-executor

Internal executor for platform application deployment steps.

This service is called by the `dataflow-platform-deploy-app` NiFi flow after
`platform-deploy-service` queues an operation and the Flink preparation job
publishes a prepared deployment request.

The executor can still run in `dry_run` for validation-only checks. In that mode
the executor:

- validates the prepared deployment payload from NiFi
- validates the requested step and operation sequence
- authenticates with the same internal bearer token used by
  `platform-deploy-service`
- returns step result metadata without mutating Terraform, Cloudflare, GitHub,
  or shell app resources

`terraform_cloud` execution is implemented behind the provider switch. The
Kubernetes manifest currently deploys this service with
`EXECUTOR_MODE=terraform_cloud` for real deployment testing.

The `local_terraform` provider remains stubbed and returns HTTP `501` until
implemented.

## Executor Endpoints

- `POST /internal/operations/{operation_id}/steps/prod-deploy`
- `POST /internal/operations/{operation_id}/steps/preview-deploy`
- `POST /internal/operations/{operation_id}/steps/preview-destroy`
- `POST /internal/operations/{operation_id}/steps/prod-destroy`

`preview-deploy` is guarded by the executor. It refuses to run unless the same
operation already has a `prod-deploy` step recorded as `succeeded`, because the
production Terraform workspace owns shared resources such as D1 and R2.

Health and contract endpoints:

- `GET /healthz`
- `GET /readyz`
- `GET /openapi.json`

## Runtime Configuration

- `EXECUTOR_MODE`: `dry_run`, `terraform_cloud`, or `local_terraform`
- `AUTH_REQUIRED`: defaults to `true`
- `INTERNAL_TOKEN`: optional static internal token for local development
- `INTERNAL_TOKEN_VAULT_PATH`: defaults to `secret/data/platform-deploy-service`
- `INTERNAL_TOKEN_VAULT_KEY`: defaults to `token`
- `TFE_TOKEN_VAULT_PATH`: defaults to `secret/data/platform-deploy-service`
- `TFE_AGENT_POOL_ID_VAULT_PATH`: defaults to `secret/data/platform-deploy-service`
- `TFE_ORGANIZATION_VAULT_PATH`: defaults to `secret/data/platform-deploy-service`
- `APP_AUTH_GATEWAY_ADMIN_TOKEN_VAULT_PATH`: defaults to `secret/data/auth-gateway-admin-api` key `value`
- `CLOUDFLARE_TOKEN_VAULT_PATH`: defaults to `secret/data/platform-deploy-service`
- `CLOUDFLARE_ACCOUNT_ID_VAULT_PATH`: defaults to `secret/data/platform-deploy-service`
- `CLOUDFLARE_ZONE_ID_VAULT_PATH`: defaults to `secret/data/platform-deploy-service`
- `VAULT_ADDR`: defaults to in-cluster Vault
- `VAULT_TOKEN_FILE`: defaults to `/vault-secrets/vault-token`

## Validation

```sh
npm install
npm run build
```

Secrets are resolved at runtime from Vault/Kubernetes. Do not commit secret
values to this repo.
