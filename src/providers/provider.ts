import { DeployRequest, StepDefinition, StepExecutionResult } from "../steps/types.js";
import { StepEvent } from "../steps/status-events.js";

export type ProviderExecutionContext = {
  request: DeployRequest;
  step: StepDefinition;
  startedAt: Date;
  emitStep: (event: StepEvent) => Promise<void>;
};

export interface DeployStepProvider {
  readonly mode: string;
  execute(context: ProviderExecutionContext): Promise<StepExecutionResult>;
}

export function terraformWorkspaceFor(request: DeployRequest, step: StepDefinition): string {
  return step.target === "production"
    ? request.terraform_workspace_production
    : request.terraform_workspace_preview;
}

export function sourceRefFor(request: DeployRequest, step: StepDefinition): string {
  if (step.target === "preview") {
    return request.template_preview_ref || "dev";
  }
  return request.template_prod_ref || request.github_ref || "prod";
}

export function buildResult(
  context: ProviderExecutionContext,
  mode: string,
  dryRun: boolean,
  extra: Record<string, unknown> = {}
): StepExecutionResult {
  const finishedAt = new Date();
  const workspace = terraformWorkspaceFor(context.request, context.step);
  const ref = sourceRefFor(context.request, context.step);
  return {
    ok: true,
    service: "platform-deploy-executor",
    mode,
    operation_id: context.request.operation_id,
    app_id: context.request.app_id,
    app_key: context.request.app_key,
    step: context.step.name,
    target: context.step.target,
    action: context.step.action,
    deployment_strategy: context.request.deployment_strategy,
    terraform_workspace: workspace,
    dry_run: dryRun,
    started_at: context.startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - context.startedAt.getTime(),
    result_json: {
      executor: "platform-deploy-executor",
      mode,
      step: context.step.name,
      target: context.step.target,
      action: context.step.action,
      dry_run: dryRun,
      app_id: context.request.app_id,
      app_key: context.request.app_key,
      site_key: context.request.site_key,
      keycloak_realm: context.request.keycloak_realm,
      source_repository: context.request.source_repository,
      ref,
      terraform_workspace: workspace,
      terraform_project: context.request.terraform_project,
      terraform_cloud_organization: context.request.terraform_cloud_organization,
      production_url: context.request.production_url,
      preview_url: context.request.preview_url,
      ...extra
    }
  };
}
