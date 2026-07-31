import { appendFile } from "node:fs/promises";
import { config } from "../config.js";
import { httpJson } from "../lib/http.js";
import { truncate } from "../lib/json.js";
import { DeploymentTarget, StepDefinition } from "../steps/types.js";
import { ResolvedDeployValues } from "./deploy-values.js";
import { TerraformCloudSecrets } from "./secrets.js";

export type AuthGatewayDeleteResult = {
  attempted: boolean;
  target: DeploymentTarget;
  slug: string;
  admin_url: string;
  deleted?: boolean;
  status?: number;
  skipped_reason?: string;
};

export async function deleteAuthGatewayRegistration(options: {
  step: StepDefinition;
  values: ResolvedDeployValues;
  secrets: TerraformCloudSecrets;
  logFile: string;
}): Promise<AuthGatewayDeleteResult> {
  const { step, values, secrets, logFile } = options;
  const slug = step.target === "production" ? values.appAuthSlugProduction : values.appAuthSlugPreview;
  const adminUrl = values.appAuthGatewayAdminUrl;

  if (!slug) {
    return skipped(step.target, slug, adminUrl, "auth-gateway app slug is empty");
  }
  if (!adminUrl) {
    return skipped(step.target, slug, adminUrl, "auth-gateway admin URL is empty");
  }
  if (!secrets.appAuthGatewayAdminToken) {
    throw Object.assign(new Error("Auth-gateway admin token is not configured."), { status: 503 });
  }

  const url = `${adminUrl}/v1/apps/${encodeURIComponent(slug)}`;
  await appendAuthGatewayLog(logFile, `deleting auth-gateway app registration ${slug} for ${step.target}`);
  const response = await httpJson<unknown>(url, {
    method: "DELETE",
    timeoutMs: config.requestTimeoutMs * 2,
    headers: {
      authorization: `Bearer ${secrets.appAuthGatewayAdminToken}`
    }
  });

  if (response.statusCode === 404) {
    await appendAuthGatewayLog(logFile, `auth-gateway app registration ${slug} was already absent`);
    return {
      attempted: true,
      target: step.target,
      slug,
      admin_url: adminUrl,
      deleted: false,
      status: response.statusCode
    };
  }

  if (response.statusCode < 200 || response.statusCode > 299) {
    throw Object.assign(
      new Error(`Failed to delete auth-gateway app registration '${slug}': HTTP ${response.statusCode} ${truncate(redact(response.text, secrets.redactedValues), 700)}`),
      { status: 502 }
    );
  }

  await appendAuthGatewayLog(logFile, `deleted auth-gateway app registration ${slug}`);
  return {
    attempted: true,
    target: step.target,
    slug,
    admin_url: adminUrl,
    deleted: true,
    status: response.statusCode
  };
}

function skipped(target: DeploymentTarget, slug: string, adminUrl: string, reason: string): AuthGatewayDeleteResult {
  return {
    attempted: false,
    target,
    slug,
    admin_url: adminUrl,
    skipped_reason: reason
  };
}

async function appendAuthGatewayLog(logFile: string, message: string): Promise<void> {
  await appendFile(logFile, `[auth-gateway] ${new Date().toISOString()} ${message}\n`, "utf8");
}

function redact(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets.filter(Boolean)) {
    result = result.split(secret).join("***");
  }
  return result;
}
