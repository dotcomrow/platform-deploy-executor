import { randomUUID } from "node:crypto";
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

type OperationStepsResponse = {
  ok?: boolean;
  operation_id?: string;
  steps?: unknown[];
};

type OperationStepResponse = {
  ok?: boolean;
  operation_id?: string;
  step_key?: string;
  step?: unknown;
};

type OperationStepStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "unknown";
type OperationStepRecord = Record<string, unknown>;

function operationStepStatus(value: unknown): OperationStepStatus {
  const normalized = asString(value, "unknown").toLowerCase();
  if (["queued", "running", "succeeded", "failed", "canceled"].includes(normalized)) {
    return normalized as OperationStepStatus;
  }
  return "unknown";
}

export async function assertOperationActive(request: DeployRequest): Promise<void> {
  if (!config.platformDeployServiceUrl) {
    throw Object.assign(new Error("Platform deploy service URL is not configured."), { status: 503 });
  }

  const token = await resolveInternalToken();
  if (!token) {
    throw Object.assign(new Error("Internal auth token is not configured."), { status: 503 });
  }

  const result = await httpJson<OperationStatusResponse>(
    `${config.platformDeployServiceUrl}/internal/operations/${encodeURIComponent(request.operation_id)}/status?_cb=${encodeURIComponent(randomUUID())}`,
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

export async function assertProductionDeploySucceeded(request: DeployRequest): Promise<void> {
  if (!config.platformDeployServiceUrl) {
    throw Object.assign(new Error("Platform deploy service URL is not configured."), { status: 503 });
  }

  const token = await resolveInternalToken();
  if (!token) {
    throw Object.assign(new Error("Internal auth token is not configured."), { status: 503 });
  }

  const deadline = Date.now() + config.productionDeployReadyTimeoutMs;
  let lastStatus: OperationStepStatus | "missing" = "missing";

  while (Date.now() <= deadline) {
    const prodDeployStep = await getProductionDeployStep(request, token);

    if (prodDeployStep) {
      const prodStepAppId = asString(prodDeployStep.app_id);
      if (prodStepAppId && prodStepAppId !== request.app_id) {
        throw Object.assign(
          new Error(`Production deploy must complete successfully before preview deploy; prod-deploy belongs to app ${prodStepAppId}, not ${request.app_id}.`),
          { status: 409 }
        );
      }

      const status = operationStepStatus(prodDeployStep.status);
      lastStatus = status;

      if (status === "succeeded") {
        return;
      }

      if (status === "failed" || status === "canceled") {
        throw Object.assign(
          new Error(`Production deploy must complete successfully before preview deploy; prod-deploy is ${status}.`),
          { status: 409 }
        );
      }
    }

    await wait(Math.min(config.productionDeployReadyPollMs, Math.max(0, deadline - Date.now())));
  }

  throw Object.assign(
    new Error(
      lastStatus === "missing"
        ? `Production deploy must complete successfully before preview deploy; operation ${request.operation_id} has no prod-deploy step yet.`
        : `Production deploy must complete successfully before preview deploy; prod-deploy is ${lastStatus}.`
    ),
    { status: 409 }
  );
}

async function getProductionDeployStep(request: DeployRequest, token: string): Promise<OperationStepRecord | null> {
  const stepResult = await httpJson<OperationStepResponse>(
    `${config.platformDeployServiceUrl}/internal/operations/${encodeURIComponent(request.operation_id)}/steps/prod-deploy?_cb=${encodeURIComponent(randomUUID())}`,
    {
      timeoutMs: config.requestTimeoutMs,
      headers: {
        authorization: `Bearer ${token}`,
        "cache-control": "no-store"
      }
    }
  );

  if (stepResult.statusCode === 404) {
    return getProductionDeployStepFromList(request, token);
  }

  if (stepResult.statusCode >= 400) {
    throw Object.assign(
      new Error(`Operation prod-deploy preflight failed HTTP ${stepResult.statusCode}: ${truncate(stepResult.text, 700)}`),
      { status: stepResult.statusCode }
    );
  }

  const stepPayload = asRecord(stepResult.payload);
  if (!stepPayload) {
    throw Object.assign(new Error("Operation prod-deploy response was not a JSON object."), { status: 502 });
  }
  const operationId = asString(stepPayload.operation_id);
  if (operationId !== request.operation_id) {
    throw Object.assign(new Error("Operation prod-deploy response id did not match request."), { status: 502 });
  }
  const step = asRecord(stepPayload.step);
  return step ?? null;
}

async function getProductionDeployStepFromList(request: DeployRequest, token: string): Promise<OperationStepRecord | null> {
  const result = await httpJson<OperationStepsResponse>(
    `${config.platformDeployServiceUrl}/internal/operations/${encodeURIComponent(request.operation_id)}/steps?_cb=${encodeURIComponent(randomUUID())}`,
    {
      timeoutMs: config.requestTimeoutMs,
      headers: {
        authorization: `Bearer ${token}`,
        "cache-control": "no-store"
      }
    }
  );

  if (result.statusCode >= 400) {
    throw Object.assign(
      new Error(`Operation step preflight failed HTTP ${result.statusCode}: ${truncate(result.text, 700)}`),
      { status: result.statusCode }
    );
  }

  const payload = asRecord(result.payload);
  if (!payload) {
    throw Object.assign(new Error("Operation steps response was not a JSON object."), { status: 502 });
  }
  const operationId = asString(payload.operation_id);
  if (operationId !== request.operation_id) {
    throw Object.assign(new Error("Operation steps response id did not match request."), { status: 502 });
  }

  const prodDeployStep = (Array.isArray(payload.steps) ? payload.steps : [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .find((step) => asString(step.step_key) === "prod-deploy");

  return prodDeployStep ?? null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
