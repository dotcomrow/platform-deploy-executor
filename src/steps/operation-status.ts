import { config } from "../config.js";
import { httpJson } from "../lib/http.js";
import { asBoolean, asRecord, asString, truncate } from "../lib/json.js";
import { resolveInternalToken } from "../lib/vault.js";
import { DeployRequest } from "./types.js";

type OperationStatusResponse = {
  ok?: boolean;
  operation_id?: string;
  app_id?: string | null;
  operation_type?: string;
  status?: string;
  active?: boolean;
};

export async function assertOperationActive(request: DeployRequest): Promise<void> {
  if (!config.platformDeployServiceUrl) {
    throw Object.assign(new Error("Platform deploy service URL is not configured."), { status: 503 });
  }

  const token = await resolveInternalToken();
  if (!token) {
    throw Object.assign(new Error("Internal auth token is not configured."), { status: 503 });
  }

  const result = await httpJson<OperationStatusResponse>(
    `${config.platformDeployServiceUrl}/internal/operations/${encodeURIComponent(request.operation_id)}/status`,
    {
      timeoutMs: config.requestTimeoutMs,
      headers: { authorization: `Bearer ${token}` }
    }
  );

  if (result.statusCode >= 400) {
    throw Object.assign(
      new Error(`Operation status check failed HTTP ${result.statusCode}: ${truncate(result.text, 700)}`),
      { status: result.statusCode }
    );
  }

  const payload = asRecord(result.payload);
  if (!payload) {
    throw Object.assign(new Error("Operation status response was not a JSON object."), { status: 502 });
  }
  const operationId = asString(payload.operation_id);
  const operationType = asString(payload.operation_type);
  const status = asString(payload.status, "unknown");
  const active = asBoolean(payload.active, false);

  if (operationId !== request.operation_id) {
    throw Object.assign(new Error("Operation status response id did not match request."), { status: 502 });
  }

  if (operationType && operationType !== request.operation_type) {
    throw Object.assign(
      new Error(`Operation ${request.operation_id} is ${operationType}; refusing ${request.operation_type} executor step.`),
      { status: 409 }
    );
  }

  if (!active) {
    throw Object.assign(
      new Error(`Operation ${request.operation_id} is ${status}; refusing to run executor step.`),
      { status: 409 }
    );
  }
}
