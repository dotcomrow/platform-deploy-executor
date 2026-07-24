import { config } from "../config.js";
import { optionalVaultValue } from "../lib/vault.js";

export type TerraformCloudSecrets = {
  githubToken: string;
  tfeToken: string;
  tfeAgentPoolId: string;
  tfeOrganization: string;
  appAuthGatewayAdminToken: string;
  cloudflareToken: string;
  cloudflareAccountId: string;
  cloudflareZoneId: string;
  redactedValues: string[];
};

export async function resolveTerraformCloudSecrets(): Promise<TerraformCloudSecrets> {
  const githubToken = config.githubToken || await optionalVaultValue(config.githubTokenVaultPath, config.githubTokenVaultKeys);
  const tfeToken = config.tfeToken || await optionalVaultValue(config.tfeTokenVaultPath, config.tfeTokenVaultKeys);
  const tfeAgentPoolId = config.tfeAgentPoolId || await optionalVaultValue(config.tfeAgentPoolIdVaultPath, config.tfeAgentPoolIdVaultKeys);
  const tfeOrganization = config.tfeOrganization || await optionalVaultValue(config.tfeOrganizationVaultPath, config.tfeOrganizationVaultKeys);
  const appAuthGatewayAdminToken = config.appAuthGatewayAdminToken
    || await optionalVaultValue(config.appAuthGatewayAdminTokenVaultPath, config.appAuthGatewayAdminTokenVaultKeys);
  const cloudflareToken = config.cloudflareToken || await optionalVaultValue(config.cloudflareTokenVaultPath, config.cloudflareTokenVaultKeys);
  const cloudflareAccountId = config.cloudflareAccountId || await optionalVaultValue(config.cloudflareAccountIdVaultPath, config.cloudflareAccountIdVaultKeys);
  const cloudflareZoneId = config.cloudflareZoneId || await optionalVaultValue(config.cloudflareZoneIdVaultPath, config.cloudflareZoneIdVaultKeys);

  return {
    githubToken,
    tfeToken,
    tfeAgentPoolId,
    tfeOrganization,
    appAuthGatewayAdminToken,
    cloudflareToken,
    cloudflareAccountId,
    cloudflareZoneId,
    redactedValues: [
      githubToken,
      tfeToken,
      appAuthGatewayAdminToken,
      cloudflareToken
    ].filter(Boolean)
  };
}
