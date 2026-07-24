# platform-deploy-executor

Internal executor for platform application deployment steps.

This service is called by the `dataflow-platform-deploy-app` NiFi flow after
`platform-deploy-service` queues an operation and the Flink preparation job
publishes a prepared deployment request.

Current execution mode is intentionally `dry_run`. In that mode the executor:

- validates the prepared deployment payload from NiFi
- validates the requested step and operation sequence
- authenticates with the same internal bearer token used by
  `platform-deploy-service`
- returns step result metadata without mutating Terraform, Cloudflare, GitHub,
  or shell app resources

Provider modules for real `terraform_cloud` and `local_terraform` execution are
stubbed and return HTTP `501` until implemented.

## Executor Endpoints

- `POST /internal/operations/{operation_id}/steps/prod-deploy`
- `POST /internal/operations/{operation_id}/steps/preview-deploy`
- `POST /internal/operations/{operation_id}/steps/preview-destroy`
- `POST /internal/operations/{operation_id}/steps/prod-destroy`

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
- `VAULT_ADDR`: defaults to in-cluster Vault
- `VAULT_TOKEN_FILE`: defaults to `/vault-secrets/vault-token`

## Validation

```sh
npm install
npm run build
```

Secrets are resolved at runtime from Vault/Kubernetes. Do not commit secret
values to this repo.
