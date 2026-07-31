import { config } from "../config.js";
import { httpJson } from "../lib/http.js";
import { JsonRecord, truncate } from "../lib/json.js";
import { resolveInternalToken } from "../lib/vault.js";

export type StepEventStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type StepEvent = {
  status: StepEventStatus;
  app_id?: string;
  step_label?: string;
  sequence?: number;
  message?: string;
  result_json?: JsonRecord;
  error_message?: string;
  log_excerpt?: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
};

export async function emitOperationStep(operationId: string, stepKey: string, event: StepEvent): Promise<void> {
  if (!config.platformDeployServiceUrl) {
    return;
  }
  try {
    const token = await resolveInternalToken();
    if (!token) {
      return;
    }
    const result = await httpJson<JsonRecord>(
      `${config.platformDeployServiceUrl}/internal/operations/${encodeURIComponent(operationId)}/steps/${encodeURIComponent(stepKey)}`,
      {
        method: "POST",
        timeoutMs: config.requestTimeoutMs,
        headers: { authorization: `Bearer ${token}` },
        body: event
      }
    );
    if (result.statusCode >= 400) {
      console.warn(`[platform-deploy-executor] step status callback failed HTTP ${result.statusCode}: ${truncate(result.text, 700)}`);
    }
  } catch (error) {
    console.warn(`[platform-deploy-executor] step status callback failed: ${error instanceof Error ? truncate(error.message, 700) : "unknown error"}`);
  }
}
