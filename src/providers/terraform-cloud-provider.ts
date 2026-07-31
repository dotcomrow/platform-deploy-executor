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
import { TfeClient } from "./tfe-client.js";

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
    await appendStage(logFile, `starting ${step.name} for ${request.app_key}`);

    await appendStage(logFile, "resolving deployment secrets");
    const secrets = await resolveTerraformCloudSecrets();
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
    const tfe = new TfeClient({
      apiBase: request.tfe_api_base || "https://app.terraform.io/api/v2",
      token: secrets.tfeToken,
      organization,
      logFile,
      redactedValues: secrets.redactedValues
    });

    if (step.action === "destroy") {
      await appendStage(logFile, `checking Terraform Cloud workspace ${workspaceName}`);
      const existingWorkspace = await tfe.getWorkspace(workspaceName);
      if (!existingWorkspace) {
        await appendStage(logFile, `Terraform Cloud workspace ${workspaceName} is already absent; skipping Terraform destroy run`);
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

    await appendStage(logFile, `checking out ${ref}`);
    const checkout = await checkoutSource({
      sourceRepository: request.source_repository,
      ref,
      targetDir: sourceDir,
      githubToken: secrets.githubToken,
      logFile
    });
    const metadata = buildMetadata(ref, request.operation_id, checkout.commit);
    await appendStage(logFile, step.action === "destroy" ? "building shell artifacts for Terraform destroy plan" : "building shell artifacts");
    await buildShellArtifacts({
      sourceDir,
      openObserveBrowserRumVersion: request.openobserve_browser_rum_version,
      logFile,
      secrets: secrets.redactedValues
    });

    await appendStage(logFile, `preparing Terraform Cloud workspace ${workspaceName}`);
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
    await appendStage(logFile, "uploading Terraform configuration");
    const configVersionId = await tfe.uploadConfiguration(workspaceId, join(sourceDir, "terraform"), operationDir);
    await appendStage(logFile, "creating Terraform run");
    const runId = await tfe.createRun(
      workspaceId,
      configVersionId,
      `Platform ${step.action} ${step.target} ${request.operation_id} for ${request.app_key}`,
      step.action === "destroy"
    );
    const runUrl = tfe.runUrl(workspaceName, runId);
    await appendStage(logFile, `polling Terraform run ${runId}`);
    const runStatus = await tfe.pollRun(
      runId,
      parsePositiveInt(request.terraform_run_timeout_seconds, 7200),
      parsePositiveInt(request.terraform_run_poll_seconds, 20)
    );
    const authGatewayDelete = step.action === "destroy"
      ? await deleteAuthGatewayRegistration({ step, values, secrets, logFile })
      : null;
    const workspaceDelete = step.action === "destroy"
      ? await deleteTerraformWorkspace(tfe, workspaceId, workspaceName, logFile)
      : null;
    const logExcerpt = await readLogExcerpt(logFile);

    return buildResult(context, this.mode, false, {
      terraform_run_id: runId,
      terraform_run_url: runUrl,
      terraform_run_status: runStatus,
      terraform_workspace_id: workspaceId,
      terraform_configuration_version_id: configVersionId,
      source_ref: ref,
      source_commit: metadata.commit,
      app_build_version: metadata.version,
      app_build_timestamp: metadata.timestamp,
      ...(authGatewayDelete ? { auth_gateway_delete: authGatewayDelete } : {}),
      ...(workspaceDelete ? { terraform_workspace_delete: workspaceDelete } : {}),
      log_excerpt: logExcerpt
    });
  }
}

async function appendStage(logFile: string, message: string): Promise<void> {
  await appendFile(logFile, `[executor] ${new Date().toISOString()} ${message}\n`, "utf8");
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

async function readLogExcerpt(logFile: string): Promise<string> {
  try {
    return tail(await readFile(logFile, "utf8"), 8000);
  } catch {
    return "";
  }
}
