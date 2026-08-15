import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { tail } from "../lib/command.js";
import { buildMetadata, buildShellArtifacts } from "../build/shell-build.js";
import { checkoutSource } from "../source/git-source.js";
import { deleteAuthGatewayRegistration } from "./auth-gateway.js";
import { sourceRefFor, terraformWorkspaceFor, buildResult, DeployStepProvider, ProviderExecutionContext } from "./provider.js";
import { resolveDeployValues, workspaceVars } from "./deploy-values.js";
import { resolveTerraformCloudSecrets } from "./secrets.js";
import { TerraformCloudRunTerminalError, TfeClient } from "./tfe-client.js";

type TerraformRunResult = {
  configVersionId: string;
  runId: string;
  runStatus: string;
  runUrl: string;
  attempts: number;
};

type StageFn = (message: string, result?: Record<string, unknown>) => Promise<void>;

export class TerraformCloudProvider implements DeployStepProvider {
  readonly mode = "terraform_cloud";

  async execute(context: ProviderExecutionContext) {
    const request = context.request;
    const step = context.step;
    const ref = sourceRefFor(request, step);
    const operationDir = join(config.workspaceRoot, request.operation_id, step.name);
    const sourceDir = join(operationDir, "source");
    const logFile = join(operationDir, "platform-deploy.log");
    await rm(operationDir, { recursive: true, force: true });
    await mkdir(operationDir, { recursive: true });
    const stage = (message: string, result: Record<string, unknown> = {}) => appendStage(logFile, message, context, result);

    try {
      await stage(`starting ${step.name} for ${request.app_key}`);

      await stage("resolving deployment secrets");
      const secrets = await resolveTerraformCloudSecrets({
        githubApiBase: request.github_api_base || config.githubApiBase
      });
      if (!secrets.tfeToken) {
        throw Object.assign(new Error("Terraform Cloud token is not configured."), { status: 503 });
      }
      const agentPoolId = request.tfe_agent_pool_id || secrets.tfeAgentPoolId;
      if (!agentPoolId) {
        throw Object.assign(new Error("Terraform Cloud agent pool id is not configured."), { status: 422 });
      }
      if (!agentPoolId.startsWith("apool-")) {
        throw Object.assign(new Error("Terraform Cloud agent pool id must start with apool-."), { status: 422 });
      }

      const values = resolveDeployValues(request, secrets);
      const organization = values.orgName;
      const workspaceName = terraformWorkspaceFor(request, step);
      const maxRunAttempts = parseBoundedPositiveInt(request.terraform_run_retry_attempts, 3, 1, 10);
      const retryDelaySeconds = parseBoundedPositiveInt(request.terraform_run_retry_delay_seconds, 60, 1, 600);
      let activeRunAttempt = 1;
      const tfe = new TfeClient({
        apiBase: request.tfe_api_base || "https://app.terraform.io/api/v2",
        token: secrets.tfeToken,
        organization,
        logFile,
        redactedValues: secrets.redactedValues,
        onRunStatus: async (runId, status) => {
          const terminal = ["errored", "canceled", "discarded", "force_canceled"].includes(status);
          const retryingErroredRun = status === "errored" && activeRunAttempt < maxRunAttempts;
          await context.emitStep({
            status: terminal && !retryingErroredRun ? "failed" : "running",
            message: retryingErroredRun
              ? `Terraform Cloud run ${runId} status: ${status}; retrying attempt ${activeRunAttempt + 1}/${maxRunAttempts}.`
              : `Terraform Cloud run ${runId} status: ${status}.`,
            result_json: {
              terraform_run_id: runId,
              terraform_run_status: status,
              terraform_run_attempt: activeRunAttempt,
              terraform_run_max_attempts: maxRunAttempts,
              terraform_workspace: workspaceName,
              terraform_run_url: tfe.runUrl(workspaceName, runId)
            }
          });
        }
      });

      if (step.action === "destroy") {
        await stage(`checking Terraform Cloud workspace ${workspaceName}`, { terraform_workspace: workspaceName });
        const existingWorkspace = await tfe.getWorkspace(workspaceName);
        if (!existingWorkspace) {
          await stage(`Terraform Cloud workspace ${workspaceName} is already absent; skipping Terraform destroy run`, { terraform_workspace: workspaceName });
          const authGatewayDelete = await deleteAuthGatewayRegistration({ step, values, secrets, logFile });
          const workspaceDelete = alreadyMissingWorkspaceDelete(workspaceName);
          const logExcerpt = await readLogExcerpt(logFile);
          return buildResult(context, this.mode, false, {
            terraform_run_status: "workspace_already_missing",
            source_ref: ref,
            auth_gateway_delete: authGatewayDelete,
            terraform_workspace_delete: workspaceDelete,
            log_excerpt: logExcerpt
          });
        }
      }

      await stage(`checking out ${ref}`, { source_ref: ref });
      const checkout = await checkoutSource({
        sourceRepository: request.source_repository,
        ref,
        targetDir: sourceDir,
        githubToken: secrets.githubToken,
        logFile
      });
      const metadata = buildMetadata(ref, request.operation_id, checkout.commit);
      await stage(step.action === "destroy" ? "building shell artifacts for Terraform destroy plan" : "building shell artifacts", {
        source_ref: ref,
        source_commit: metadata.commit
      });
      await buildShellArtifacts({
        sourceDir,
        openObserveBrowserRumVersion: request.openobserve_browser_rum_version,
        logFile,
        secrets: secrets.redactedValues
      });

      await stage(`preparing Terraform Cloud workspace ${workspaceName}`, { terraform_workspace: workspaceName });
      const projectId = await tfe.lookupProjectId(request.terraform_project);
      const workspaceId = await tfe.createOrGetWorkspace(workspaceName, projectId, agentPoolId);
      await tfe.upsertTerraformVars(workspaceId, workspaceVars({
        request,
        step,
        values,
        secrets,
        buildVersion: metadata.version,
        buildCommit: metadata.commit,
        buildTimestamp: metadata.timestamp
      }));
      const run = await executeTerraformRunWithRetries({
        tfe,
        context,
        stage,
        request,
        stepAction: step.action,
        stepTarget: step.target,
        workspaceId,
        workspaceName,
        sourceTerraformDir: join(sourceDir, "terraform"),
        operationDir,
        logFile,
        maxAttempts: maxRunAttempts,
        retryDelaySeconds,
        setActiveRunAttempt: (attempt) => {
          activeRunAttempt = attempt;
        }
      });
      const authGatewayDelete = step.action === "destroy"
        ? await deleteAuthGatewayRegistration({ step, values, secrets, logFile })
        : null;
      const workspaceDelete = step.action === "destroy"
        ? await deleteTerraformWorkspace(tfe, workspaceId, workspaceName, logFile)
        : null;
      const logExcerpt = await readLogExcerpt(logFile);

      return buildResult(context, this.mode, false, {
        terraform_run_id: run.runId,
        terraform_run_url: run.runUrl,
        terraform_run_status: run.runStatus,
        terraform_run_attempts: run.attempts,
        terraform_run_max_attempts: maxRunAttempts,
        terraform_workspace_id: workspaceId,
        terraform_configuration_version_id: run.configVersionId,
        source_ref: ref,
        source_commit: metadata.commit,
        app_build_version: metadata.version,
        app_build_timestamp: metadata.timestamp,
        ...(authGatewayDelete ? { auth_gateway_delete: authGatewayDelete } : {}),
        ...(workspaceDelete ? { terraform_workspace_delete: workspaceDelete } : {}),
        log_excerpt: logExcerpt
      });
    } catch (error) {
      const logExcerpt = await readLogExcerpt(logFile);
      await context.emitStep({
        status: "failed",
        message: `${step.name} failed.`,
        error_message: error instanceof Error ? error.message : "Step failed.",
        log_excerpt: logExcerpt || (error instanceof Error ? error.stack || error.message : String(error))
      });
      throw error;
    } finally {
      await cleanupOperationDir(operationDir);
    }
  }
}

async function executeTerraformRunWithRetries(options: {
  tfe: TfeClient;
  context: ProviderExecutionContext;
  stage: StageFn;
  request: { operation_id: string; app_key: string; terraform_run_timeout_seconds: unknown; terraform_run_poll_seconds: unknown };
  stepAction: string;
  stepTarget: string;
  workspaceId: string;
  workspaceName: string;
  sourceTerraformDir: string;
  operationDir: string;
  logFile: string;
  maxAttempts: number;
  retryDelaySeconds: number;
  setActiveRunAttempt: (attempt: number) => void;
}): Promise<TerraformRunResult> {
  const timeoutSeconds = parsePositiveInt(options.request.terraform_run_timeout_seconds, 7200);
  const pollSeconds = parsePositiveInt(options.request.terraform_run_poll_seconds, 20);
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    options.setActiveRunAttempt(attempt);
    const attemptSuffix = options.maxAttempts > 1 ? ` (attempt ${attempt}/${options.maxAttempts})` : "";
    await options.stage(`uploading Terraform configuration${attemptSuffix}`, {
      terraform_workspace: options.workspaceName,
      terraform_workspace_id: options.workspaceId,
      terraform_run_attempt: attempt,
      terraform_run_max_attempts: options.maxAttempts
    });
    const configVersionId = await options.tfe.uploadConfiguration(options.workspaceId, options.sourceTerraformDir, options.operationDir);
    await options.stage(`creating Terraform run${attemptSuffix}`, {
      terraform_workspace: options.workspaceName,
      terraform_configuration_version_id: configVersionId,
      terraform_run_attempt: attempt,
      terraform_run_max_attempts: options.maxAttempts
    });
    const runId = await options.tfe.createRun(
      options.workspaceId,
      configVersionId,
      `Platform ${options.stepAction} ${options.stepTarget} ${options.request.operation_id} for ${options.request.app_key} attempt ${attempt}/${options.maxAttempts}`,
      options.stepAction === "destroy"
    );
    const runUrl = options.tfe.runUrl(options.workspaceName, runId);
    await options.stage(`polling Terraform run ${runId}${attemptSuffix}`, {
      terraform_run_id: runId,
      terraform_run_url: runUrl,
      terraform_run_attempt: attempt,
      terraform_run_max_attempts: options.maxAttempts
    });

    try {
      const runStatus = await options.tfe.pollRun(runId, timeoutSeconds, pollSeconds);
      return { configVersionId, runId, runStatus, runUrl, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!shouldRetryTerraformRun(error, attempt, options.maxAttempts)) {
        throw error;
      }
      await appendFile(
        options.logFile,
        `[executor] ${new Date().toISOString()} Terraform Cloud run ${runId} ended errored; retrying in ${options.retryDelaySeconds}s (attempt ${attempt + 1}/${options.maxAttempts}).\n`,
        "utf8"
      );
      await options.context.emitStep({
        status: "running",
        message: `Terraform Cloud run ${runId} errored; retrying in ${options.retryDelaySeconds}s.`,
        result_json: {
          terraform_run_id: runId,
          terraform_run_url: runUrl,
          terraform_run_status: "errored",
          terraform_run_attempt: attempt,
          terraform_run_max_attempts: options.maxAttempts,
          terraform_retry_next_attempt: attempt + 1,
          terraform_retry_delay_seconds: options.retryDelaySeconds,
          terraform_workspace: options.workspaceName
        }
      });
      await delay(options.retryDelaySeconds * 1000);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Terraform Cloud run failed after retry attempts.");
}

function shouldRetryTerraformRun(error: unknown, attempt: number, maxAttempts: number): boolean {
  return error instanceof TerraformCloudRunTerminalError
    && error.status === "errored"
    && attempt < maxAttempts;
}

async function appendStage(
  logFile: string,
  message: string,
  context?: ProviderExecutionContext,
  result: Record<string, unknown> = {}
): Promise<void> {
  await appendFile(logFile, `[executor] ${new Date().toISOString()} ${message}\n`, "utf8");
  if (context) {
    await context.emitStep({
      status: "running",
      message,
      result_json: {
        stage: message,
        ...result
      }
    });
  }
}

async function deleteTerraformWorkspace(tfe: TfeClient, workspaceId: string, workspaceName: string, logFile: string) {
  await appendStage(logFile, `safe-deleting Terraform Cloud workspace ${workspaceName}`);
  return tfe.safeDeleteWorkspace(workspaceId, workspaceName);
}

function alreadyMissingWorkspaceDelete(workspaceName: string) {
  return {
    deleted: false,
    already_missing: true,
    status_code: 404,
    workspace_id: "",
    workspace_name: workspaceName,
    attempts: 1
  };
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseBoundedPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = parsePositiveInt(value, fallback);
  return Math.max(min, Math.min(max, parsed));
}

async function readLogExcerpt(logFile: string): Promise<string> {
  try {
    return tail(await readFile(logFile, "utf8"), 8000);
  } catch {
    return "";
  }
}

async function cleanupOperationDir(operationDir: string): Promise<void> {
  try {
    await rm(operationDir, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[platform-deploy-executor] failed to clean workspace directory ${operationDir}: ${message}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
