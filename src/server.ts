import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { config } from "./config.js";
import { enforceInternalAuth } from "./auth/internal-auth.js";
import { resolveInternalToken } from "./lib/vault.js";
import { truncate } from "./lib/json.js";
import { openApiSpec } from "./openapi.js";
import { executeStep } from "./steps/execute-step.js";
import { DeploymentStepName } from "./steps/types.js";
import { parseStepName } from "./steps/validation.js";

const app = express();
app.set("trust proxy", config.trustProxyHops);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("combined"));
app.use(rateLimit({ windowMs: config.rateWindowMs, limit: config.rateMax, standardHeaders: "draft-7", legacyHeaders: false }));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true, service: "platform-deploy-executor", version: "1.0.0" });
});

app.get("/readyz", async (_req, res) => {
  try {
    if (config.authRequired) {
      await resolveInternalToken();
    }
    res.status(200).json({
      ok: true,
      service: "platform-deploy-executor",
      mode: config.executorMode,
      auth_required: config.authRequired
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      service: "platform-deploy-executor",
      reason: "executor_dependency_failed",
      error: error instanceof Error ? truncate(error.message, 500) : "Unknown readiness error"
    });
  }
});

app.get("/openapi.json", (_req, res) => {
  res.status(200).json(openApiSpec);
});

async function handleStep(req: Request, res: Response, stepName: DeploymentStepName): Promise<void> {
  await enforceInternalAuth(req);
  const result = await executeStep(req.params.id, stepName, req.body);
  res.status(200).json(result);
}

app.post("/internal/operations/:id/steps/:step", async (req, res, next) => {
  try {
    const stepName = parseStepName(req.params.step);
    await handleStep(req, res, stepName);
  } catch (error) {
    next(error);
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: { message: "Not found", status: 404 } });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof ZodError
    ? 422
    : Math.max(400, Math.min(599, Number((err as { status?: number }).status) || 500));
  const message = err instanceof ZodError
    ? err.errors.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")
    : err instanceof Error ? err.message : "Internal server error";

  if (status >= 500) {
    console.error(`[platform-deploy-executor] request failed status=${status}: ${truncate(message, 1000)}`);
  }

  res.status(status).json({
    error: {
      message,
      status
    }
  });
});

app.listen(config.port, () => {
  console.log(`[platform-deploy-executor] listening on :${config.port} mode=${config.executorMode}`);
});
