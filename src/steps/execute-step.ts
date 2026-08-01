import { providerForConfiguredMode } from "../providers/index.js";
import { DeploymentStepName, StepExecutionResult } from "./types.js";
import { parseDeployRequest, stepDefinitions } from "./validation.js";
import { emitOperationStep, StepEvent } from "./status-events.js";
import { assertOperationActive } from "./operation-status.js";

export async function executeStep(operationId: string, stepName: DeploymentStepName, body: unknown): Promise<StepExecutionResult> {
  const request = parseDeployRequest(operationId, stepName, body);
  await assertOperationActive(request);
  const provider = providerForConfiguredMode();
  const startedAt = new Date();
  const step = stepDefinitions[stepName];
  const emitStep = (event: StepEvent) => emitOperationStep(request.operation_id, stepName, {
    app_id: request.app_id,
    ...event
  });

  await emitStep({
    status: "running",
    step_label: stepLabel(stepName),
    message: `Started ${stepLabel(stepName)}.`,
    started_at: startedAt.toISOString()
  });

  try {
    const result = await provider.execute({
      request,
      step,
      startedAt,
      emitStep
    });
    await emitStep({
      status: "succeeded",
      step_label: stepLabel(stepName),
      message: `Finished ${stepLabel(stepName)}.`,
      result_json: result.result_json,
      started_at: result.started_at,
      finished_at: result.finished_at,
      duration_ms: result.duration_ms,
      log_excerpt: typeof result.result_json.log_excerpt === "string" ? result.result_json.log_excerpt : undefined
    });
    return result;
  } catch (error) {
    const finishedAt = new Date();
    await emitStep({
      status: "failed",
      step_label: stepLabel(stepName),
      message: `Failed ${stepLabel(stepName)}.`,
      error_message: error instanceof Error ? error.message : "Step failed.",
      log_excerpt: error instanceof Error ? error.stack || error.message : String(error),
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime()
    });
    throw error;
  }
}

function stepLabel(stepName: string): string {
  return stepName
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
