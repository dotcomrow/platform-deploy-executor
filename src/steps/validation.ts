import { DeployRequest, DeploymentStepName, StepDefinition, deployRequestSchema, stepNameSchema } from "./types.js";

export const stepDefinitions: Record<DeploymentStepName, StepDefinition> = {
  "prod-deploy": {
    name: "prod-deploy",
    target: "production",
    action: "deploy",
    requiredSequence: "create-or-recreate"
  },
  "preview-deploy": {
    name: "preview-deploy",
    target: "preview",
    action: "deploy",
    requiredSequence: "create-or-recreate"
  },
  "preview-destroy": {
    name: "preview-destroy",
    target: "preview",
    action: "destroy",
    requiredSequence: "recreate-or-destroy"
  },
  "prod-destroy": {
    name: "prod-destroy",
    target: "production",
    action: "destroy",
    requiredSequence: "recreate-or-destroy"
  }
};

export function parseStepName(value: string): DeploymentStepName {
  return stepNameSchema.parse(value);
}

export function parseDeployRequest(operationId: string, step: DeploymentStepName, body: unknown): DeployRequest {
  const payload = deployRequestSchema.parse(body);
  if (payload.operation_id !== operationId) {
    throw Object.assign(new Error("operation_id path/body mismatch."), { status: 422 });
  }

  const definition = stepDefinitions[step];
  if (definition.requiredSequence === "create-or-recreate" && payload.sequence === "destroy") {
    throw Object.assign(new Error(`${step} cannot run for destroy sequence.`), { status: 422 });
  }
  if (definition.requiredSequence === "recreate-or-destroy" && payload.sequence === "create") {
    throw Object.assign(new Error(`${step} cannot run for create sequence.`), { status: 422 });
  }

  if (payload.deployment_strategy === "terraform_cloud") {
    const missing = [
      ["terraform_project", payload.terraform_project],
      ["terraform_cloud_organization", payload.terraform_cloud_organization],
      ["organization_id", payload.organization_id],
      ["github_repository", payload.github_repository],
      ["github_ref", payload.github_ref]
    ].filter(([, value]) => !String(value ?? "").trim());
    if (missing.length) {
      throw Object.assign(new Error(`Missing Terraform Cloud deployment fields: ${missing.map(([name]) => name).join(", ")}`), { status: 422 });
    }
  }

  const workspace = definition.target === "production" ? payload.terraform_workspace_production : payload.terraform_workspace_preview;
  if (!workspace.trim()) {
    throw Object.assign(new Error(`Missing Terraform workspace for ${definition.target} step.`), { status: 422 });
  }

  return payload;
}
