import { providerForConfiguredMode } from "../providers/index.js";
import { DeploymentStepName, StepExecutionResult } from "./types.js";
import { parseDeployRequest, stepDefinitions } from "./validation.js";

export async function executeStep(operationId: string, stepName: DeploymentStepName, body: unknown): Promise<StepExecutionResult> {
  const request = parseDeployRequest(operationId, stepName, body);
  const provider = providerForConfiguredMode();
  return provider.execute({
    request,
    step: stepDefinitions[stepName],
    startedAt: new Date()
  });
}
