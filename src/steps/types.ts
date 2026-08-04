import { z } from "zod";

export const operationTypeSchema = z.enum(["create", "update", "redeploy", "delete", "destroy"]);
export const sequenceSchema = z.enum(["create", "recreate", "destroy"]);
export const deploymentStrategySchema = z.enum(["terraform_cloud", "local_terraform"]);
export const stepNameSchema = z.enum(["prod-deploy", "preview-deploy", "preview-destroy", "prod-destroy"]);

export const deployRequestSchema = z.object({
  operation_id: z.string().min(1),
  operation_type: operationTypeSchema,
  sequence: sequenceSchema,
  deployment_strategy: deploymentStrategySchema,
  app_id: z.string().min(1),
  app_key: z.string().min(1),
  site_key: z.string().min(1),
  keycloak_realm: z.enum(["internal", "external"]),
  domain: z.string().optional().default(""),
  production_hostname: z.string().optional().default(""),
  preview_hostname: z.string().optional().default(""),
  production_url: z.string().optional().default(""),
  preview_url: z.string().optional().default(""),
  source_repository: z.string().min(1),
  template_prod_ref: z.string().optional().default("prod"),
  template_preview_ref: z.string().optional().default("prod"),
  terraform_project: z.string().optional().default(""),
  terraform_cloud_organization: z.string().optional().default(""),
  tfe_agent_pool_id: z.string().optional().default(""),
  keycloak_auth_host: z.string().optional().default(""),
  app_auth_gateway_url: z.string().optional().default(""),
  app_auth_gateway_admin_url: z.string().optional().default(""),
  app_auth_slug_production: z.string().optional().default(""),
  app_auth_slug_preview: z.string().optional().default(""),
  terraform_workspace_production: z.string().optional().default(""),
  terraform_workspace_preview: z.string().optional().default(""),
  github_api_base: z.string().optional().default("https://api.github.com"),
  github_repository: z.string().optional().default(""),
  github_initial_workflow: z.string().optional().default("initial-deploy.yml"),
  github_ref: z.string().optional().default("prod"),
  tfe_api_base: z.string().optional().default("https://app.terraform.io/api/v2"),
  terraform_run_timeout_seconds: z.number().int().positive().or(z.string()).optional().default(7200),
  terraform_run_poll_seconds: z.number().int().positive().or(z.string()).optional().default(20),
  terraform_run_retry_attempts: z.number().int().positive().or(z.string()).optional().default(3),
  terraform_run_retry_delay_seconds: z.number().int().positive().or(z.string()).optional().default(60),
  openobserve_browser_rum_version: z.string().optional().default("0.3.1"),
  github_repository_variables: z.record(z.unknown()).optional().default({}),
  prepared_at: z.string().optional().default(""),
  prepared_by: z.string().optional().default(""),
  source: z.string().optional().default(""),
  nifi_target_topic: z.string().optional().default("")
}).passthrough();

export type DeploymentStepName = z.infer<typeof stepNameSchema>;
export type DeployRequest = z.infer<typeof deployRequestSchema>;

export type DeploymentTarget = "production" | "preview";
export type DeploymentAction = "deploy" | "destroy";

export type StepDefinition = {
  name: DeploymentStepName;
  target: DeploymentTarget;
  action: DeploymentAction;
  requiredSequence: "create-or-recreate" | "recreate-or-destroy";
};

export type StepExecutionResult = {
  ok: true;
  service: "platform-deploy-executor";
  mode: string;
  operation_id: string;
  app_id: string;
  app_key: string;
  step: DeploymentStepName;
  target: DeploymentTarget;
  action: DeploymentAction;
  deployment_strategy: string;
  terraform_workspace: string;
  dry_run: boolean;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  result_json: Record<string, unknown>;
};
