import { config } from "./config.js";

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Platform Deploy Executor API",
    version: "1.0.0",
    description: "Internal execution service for platform app deployment steps orchestrated by NiFi."
  },
  servers: [{ url: config.openApiServerUrl }],
  components: {
    securitySchemes: {
      internalBearer: {
        type: "http",
        scheme: "bearer"
      }
    },
    parameters: {
      OperationIdPath: {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Directus platform_app_operations id."
      }
    },
    schemas: {
      DeployStepRequest: {
        type: "object",
        required: [
          "operation_id",
          "operation_type",
          "sequence",
          "deployment_strategy",
          "app_id",
          "app_key",
          "site_key",
          "keycloak_realm",
          "source_repository"
        ],
        additionalProperties: true,
        properties: {
          operation_id: { type: "string" },
          operation_type: { type: "string", enum: ["create", "update", "redeploy", "delete", "destroy"] },
          sequence: { type: "string", enum: ["create", "recreate", "destroy"] },
          deployment_strategy: { type: "string", enum: ["terraform_cloud", "local_terraform"] },
          app_id: { type: "string" },
          organization_id: { type: "string" },
          app_key: { type: "string" },
          site_key: { type: "string" },
          keycloak_realm: { type: "string", enum: ["internal", "external"] },
          source_repository: { type: "string" },
          terraform_workspace_production: { type: "string" },
          terraform_workspace_preview: { type: "string" },
          github_repository: { type: "string" },
          github_ref: { type: "string" },
          terraform_project: { type: "string" },
          terraform_cloud_organization: { type: "string" },
          terraform_run_retry_attempts: { type: "integer", minimum: 1, maximum: 10, default: 3 },
          terraform_run_retry_delay_seconds: { type: "integer", minimum: 1, maximum: 600, default: 60 }
        }
      },
      StepResponse: {
        type: "object",
        required: ["ok", "service", "mode", "operation_id", "app_id", "app_key", "step", "target", "action", "dry_run"],
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          service: { type: "string" },
          mode: { type: "string" },
          operation_id: { type: "string" },
          app_id: { type: "string" },
          app_key: { type: "string" },
          step: { type: "string" },
          target: { type: "string" },
          action: { type: "string" },
          dry_run: { type: "boolean" },
          result_json: { type: "object", additionalProperties: true }
        }
      },
      ErrorResponse: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              message: { type: "string" },
              status: { type: "integer" }
            }
          }
        }
      }
    }
  },
  paths: {
    "/healthz": { get: { operationId: "healthz", responses: { "200": { description: "Service health" } } } },
    "/readyz": { get: { operationId: "readyz", responses: { "200": { description: "Service readiness" }, "503": { description: "Not ready" } } } },
    "/internal/operations/{id}/steps/prod-deploy": { post: { operationId: "prodDeploy", security: [{ internalBearer: [] }], parameters: [{ $ref: "#/components/parameters/OperationIdPath" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/DeployStepRequest" } } } }, responses: { "200": { description: "Production deploy step completed", content: { "application/json": { schema: { $ref: "#/components/schemas/StepResponse" } } } }, "422": { description: "Invalid deployment request" }, "501": { description: "Configured provider is not implemented" } } } },
    "/internal/operations/{id}/steps/preview-deploy": { post: { operationId: "previewDeploy", security: [{ internalBearer: [] }], parameters: [{ $ref: "#/components/parameters/OperationIdPath" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/DeployStepRequest" } } } }, responses: { "200": { description: "Preview deploy step completed", content: { "application/json": { schema: { $ref: "#/components/schemas/StepResponse" } } } }, "409": { description: "Production deploy has not completed successfully for this operation" }, "422": { description: "Invalid deployment request" }, "501": { description: "Configured provider is not implemented" } } } },
    "/internal/operations/{id}/steps/preview-destroy": { post: { operationId: "previewDestroy", security: [{ internalBearer: [] }], parameters: [{ $ref: "#/components/parameters/OperationIdPath" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/DeployStepRequest" } } } }, responses: { "200": { description: "Preview destroy step completed", content: { "application/json": { schema: { $ref: "#/components/schemas/StepResponse" } } } }, "422": { description: "Invalid deployment request" }, "501": { description: "Configured provider is not implemented" } } } },
    "/internal/operations/{id}/steps/prod-destroy": { post: { operationId: "prodDestroy", security: [{ internalBearer: [] }], parameters: [{ $ref: "#/components/parameters/OperationIdPath" }], requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/DeployStepRequest" } } } }, responses: { "200": { description: "Production destroy step completed", content: { "application/json": { schema: { $ref: "#/components/schemas/StepResponse" } } } }, "422": { description: "Invalid deployment request" }, "501": { description: "Configured provider is not implemented" } } } }
  }
};
