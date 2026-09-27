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
  let lastError = "unknown callback failure";
  for (let attempt = 1; attempt <= config.statusCallbackMaxAttempts; attempt += 1) {
    try {
      const token = await resolveInternalToken();
      if (!token) {
        throw new Error("internal callback token is unavailable");
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
      if (result.statusCode >= 200 && result.statusCode < 300) return;
      lastError = `HTTP ${result.statusCode}: ${truncate(result.text, 700)}`;
      if (![408, 425, 429, 500, 502, 503, 504].includes(result.statusCode)) {
        throw new Error(`non-retryable step status callback failure ${lastError}`);
      }
    } catch (error) {
      lastError = error instanceof Error ? truncate(error.message, 700) : "unknown error";
    }
    if (attempt < config.statusCallbackMaxAttempts) {
      const base = Math.min(config.statusCallbackMaxBackoffMs, config.statusCallbackInitialBackoffMs * (2 ** (attempt - 1)));
      const delay = Math.round(base * (0.75 + Math.random() * 0.5));
      console.warn(`[platform-deploy-executor] step status callback attempt ${attempt}/${config.statusCallbackMaxAttempts} failed: ${lastError}; retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(`step status callback was not acknowledged after ${config.statusCallbackMaxAttempts} attempts: ${lastError}`);
}
