import { config } from "../config.js";
import { optionalVaultValue } from "../lib/vault.js";
import { createGitHubInstallationToken } from "../source/github-app-auth.js";

export type GitHubSourceAuthMode = "none" | "token" | "github_app";

export type TerraformCloudSecrets = {
  githubToken: string;
  githubAuthMode: GitHubSourceAuthMode;
  tfeToken: string;
  tfeAgentPoolId: string;
  tfeOrganization: string;
  appAuthGatewayAdminToken: string;
  cloudflareToken: string;
  cloudflareAccountId: string;
  cloudflareZoneId: string;
  redactedValues: string[];
};

export async function resolveTerraformCloudSecrets(options: {
  githubApiBase?: string;
} = {}): Promise<TerraformCloudSecrets> {
  const githubTokenFromSecret = config.githubToken || await optionalVaultValue(config.githubTokenVaultPath, config.githubTokenVaultKeys);
  const githubCredentials = await resolveGitHubSourceCredentials({
    githubApiBase: options.githubApiBase || config.githubApiBase,
    staticToken: githubTokenFromSecret
  });
  const tfeToken = config.tfeToken || await optionalVaultValue(config.tfeTokenVaultPath, config.tfeTokenVaultKeys);
  const tfeAgentPoolId = config.tfeAgentPoolId || await optionalVaultValue(config.tfeAgentPoolIdVaultPath, config.tfeAgentPoolIdVaultKeys);
  const tfeOrganization = config.tfeOrganization || await optionalVaultValue(config.tfeOrganizationVaultPath, config.tfeOrganizationVaultKeys);
  const appAuthGatewayAdminToken = config.appAuthGatewayAdminToken
    || await optionalVaultValue(config.appAuthGatewayAdminTokenVaultPath, config.appAuthGatewayAdminTokenVaultKeys);
  const cloudflareToken = config.cloudflareToken || await optionalVaultValue(config.cloudflareTokenVaultPath, config.cloudflareTokenVaultKeys);
  const cloudflareAccountId = config.cloudflareAccountId || await optionalVaultValue(config.cloudflareAccountIdVaultPath, config.cloudflareAccountIdVaultKeys);
  const cloudflareZoneId = config.cloudflareZoneId || await optionalVaultValue(config.cloudflareZoneIdVaultPath, config.cloudflareZoneIdVaultKeys);

  return {
    githubToken: githubCredentials.token,
    githubAuthMode: githubCredentials.mode,
    tfeToken,
    tfeAgentPoolId,
    tfeOrganization,
    appAuthGatewayAdminToken,
    cloudflareToken,
    cloudflareAccountId,
    cloudflareZoneId,
    redactedValues: [
      githubCredentials.token,
      githubCredentials.privateKey,
      tfeToken,
      appAuthGatewayAdminToken,
      cloudflareToken
    ].filter(Boolean)
  };
}

async function resolveGitHubSourceCredentials(options: {
  githubApiBase: string;
  staticToken: string;
}): Promise<{ mode: GitHubSourceAuthMode; privateKey: string; token: string }> {
  const mode = config.githubAuthMode;
  if (mode !== "github_app" && options.staticToken) {
    return { mode: "token", privateKey: "", token: options.staticToken };
  }

  if (mode === "token") {
    return { mode: options.staticToken ? "token" : "none", privateKey: "", token: options.staticToken };
  }

  const appId = config.githubAppId || await optionalVaultValue(config.githubAppIdVaultPath, config.githubAppIdVaultKeys);
  const installationId = config.githubAppInstallationId
    || await optionalVaultValue(config.githubAppInstallationIdVaultPath, config.githubAppInstallationIdVaultKeys);
  const privateKey = config.githubAppPrivateKey
    || await optionalVaultValue(config.githubAppPrivateKeyVaultPath, config.githubAppPrivateKeyVaultKeys);
  const hasGitHubAppCredentials = Boolean(appId && installationId && privateKey);

  if (!hasGitHubAppCredentials) {
    if (mode === "github_app") {
      throw Object.assign(
        new Error("GitHub App auth is selected, but github_app_id, github_app_installation_id, and github_app_private_key are not configured."),
        { status: 503 }
      );
    }
    return { mode: options.staticToken ? "token" : "none", privateKey: "", token: options.staticToken };
  }

  const installationToken = await createGitHubInstallationToken({
    appId,
    installationId,
    privateKey,
    apiBase: options.githubApiBase,
    timeoutMs: config.requestTimeoutMs
  });
  return { mode: "github_app", privateKey, token: installationToken.token };
}
