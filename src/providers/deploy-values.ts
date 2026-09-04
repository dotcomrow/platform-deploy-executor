import { DeployRequest, StepDefinition } from "../steps/types.js";
import { config } from "../config.js";
import { asBoolean } from "../lib/json.js";
import { parseGitHubFullName } from "../source/git-source.js";
import { TerraformCloudSecrets } from "./secrets.js";
import { TerraformVar } from "./tfe-client.js";

export type ResolvedDeployValues = {
  projectName: string;
  projectSlug: string;
  orgName: string;
  realm: "internal" | "external";
  domain: string;
  appAuthGatewayUrl: string;
  appAuthGatewayAdminUrl: string;
  appAuthBaseUrlProduction: string;
  appAuthBaseUrlPreview: string;
  appAuthSlugProduction: string;
  appAuthSlugPreview: string;
  keycloakAuthHost: string;
  cacheRefreshAuthIssuer: string;
  cacheRefreshAuthJwksUrl: string;
  directusAuthTokenUrl: string;
  cacheRefreshAllowedClients: string;
  d1DevCacheName: string;
  d1ProdCacheName: string;
  r2DevMediaCacheName: string;
  r2ProdMediaCacheName: string;
  openObserveOrganizationIdentifier: string;
  openObserveSourceMapUploadUrl: string;
  openObserveSourceMapUploadAuthScheme: string;
  openObserveSourceMapUploadAuthTokenLookupFromVault: boolean;
  openObserveSourceMapUploadAuthTokenVaultMount: string;
  openObserveSourceMapUploadAuthTokenVaultName: string;
  openObserveSourceMapUploadAuthTokenVaultField: string;
};

export function resolveDeployValues(request: DeployRequest, secrets: TerraformCloudSecrets): ResolvedDeployValues {
  const projectName = request.app_key.trim();
  const projectSlug = slugify(projectName) || "app";
  const realm = request.keycloak_realm;
  const domain = request.domain.trim() || "suncoast.systems";
  const defaultAuthGatewayUrl = realm === "internal" ? "https://login-internal.suncoast.systems" : "https://login.suncoast.systems";
  const keycloakAuthHost = stripProtocolAndPath(request.keycloak_auth_host.trim() || "auth-origin.suncoast.systems");
  const cacheRefreshAuthIssuer = `https://${keycloakAuthHost}/realms/${realm}`;
  const cacheRefreshAuthJwksUrl = `${cacheRefreshAuthIssuer}/protocol/openid-connect/certs`;
  const sourceFullName = parseGitHubFullName(request.source_repository);
  const sourceOwner = sourceFullName.split("/")[0] || "";

  return {
    projectName,
    projectSlug,
    orgName: request.terraform_cloud_organization || secrets.tfeOrganization || sourceOwner || "suncoast-systems",
    realm,
    domain,
    appAuthGatewayUrl: trimTrailingSlash(request.app_auth_gateway_url.trim() || defaultAuthGatewayUrl),
    appAuthGatewayAdminUrl: trimTrailingSlash(request.app_auth_gateway_admin_url.trim() || defaultAuthGatewayUrl),
    appAuthBaseUrlProduction: request.production_url.trim() || `https://${request.app_key}.${domain}`,
    appAuthBaseUrlPreview: request.preview_url.trim() || `https://${request.app_key}-preview.${domain}`,
    appAuthSlugProduction: request.app_auth_slug_production.trim() || projectSlug,
    appAuthSlugPreview: request.app_auth_slug_preview.trim() || `${projectSlug}-preview`,
    keycloakAuthHost,
    cacheRefreshAuthIssuer,
    cacheRefreshAuthJwksUrl,
    directusAuthTokenUrl: `${cacheRefreshAuthIssuer}/protocol/openid-connect/token`,
    cacheRefreshAllowedClients: `cms-site-${realm}`,
    d1DevCacheName: `${projectSlug}-dev-cache`,
    d1ProdCacheName: `${projectSlug}-prod-cache`,
    r2DevMediaCacheName: `${projectSlug}-dev-media-cache`,
    r2ProdMediaCacheName: `${projectSlug}-prod-media-cache`,
    openObserveOrganizationIdentifier: request.app_log_openobserve_organization_identifier.trim() || config.defaultOpenObserveSourceMapOrg,
    openObserveSourceMapUploadUrl: trimTrailingSlash(request.openobserve_sourcemap_upload_url.trim() || config.defaultOpenObserveSourceMapUploadUrl),
    openObserveSourceMapUploadAuthScheme: request.openobserve_sourcemap_upload_auth_scheme.trim() || config.defaultOpenObserveSourceMapUploadAuthScheme,
    openObserveSourceMapUploadAuthTokenLookupFromVault: asBoolean(
      request.openobserve_sourcemap_upload_auth_token_lookup_from_vault,
      config.defaultOpenObserveSourceMapUploadAuthTokenLookupFromVault
    ),
    openObserveSourceMapUploadAuthTokenVaultMount: request.openobserve_sourcemap_upload_auth_token_vault_mount.trim()
      || config.defaultOpenObserveSourceMapUploadAuthTokenVaultMount,
    openObserveSourceMapUploadAuthTokenVaultName: request.openobserve_sourcemap_upload_auth_token_vault_name.trim()
      || config.defaultOpenObserveSourceMapUploadAuthTokenVaultName,
    openObserveSourceMapUploadAuthTokenVaultField: request.openobserve_sourcemap_upload_auth_token_vault_field.trim()
      || config.defaultOpenObserveSourceMapUploadAuthTokenVaultField
  };
}

export function workspaceVars(options: {
  request: DeployRequest;
  step: StepDefinition;
  values: ResolvedDeployValues;
  secrets: TerraformCloudSecrets;
  buildVersion: string;
  buildCommit: string;
  buildTimestamp: string;
  openObserveSourceMapUploadEnabled: boolean;
}): TerraformVar[] {
  const deploymentEnvironment = options.step.target === "production" ? "production" : "preview";
  const ownsSharedResources = options.step.target === "production";
  return [
    tv("project_name", options.values.projectName, "project name"),
    tv("org_name", options.values.orgName, "organization name"),
    tv("domain", options.values.domain, "application domain"),
    tv("manage_d1_resources", String(ownsSharedResources), "manage Cloudflare D1 resources", true),
    tv("manage_r2_resources", String(ownsSharedResources), "manage Cloudflare R2 resources", true),
    tv("directus_client_lookup_from_vault", "true", "resolve Directus client credentials from Vault", true),
    tv("cache_refresh_auth_audience_lookup_from_vault", "true", "resolve refresh auth audience from Vault", true),
    tv("keycloak_realm", options.values.realm, "Keycloak realm selector"),
    tv("directus_content_site_key", options.request.site_key, "Directus content site key"),
    tv("directus_auth_token_url", options.values.directusAuthTokenUrl, "Directus token endpoint"),
    tv("cache_refresh_auth_issuer", options.values.cacheRefreshAuthIssuer, "refresh token issuer"),
    tv("cache_refresh_auth_jwks_url", options.values.cacheRefreshAuthJwksUrl, "refresh token JWKS URL"),
    tv("cache_refresh_auth_allowed_clients", options.values.cacheRefreshAllowedClients, "allowed refresh token clients"),
    tv("app_auth_gateway_url", options.values.appAuthGatewayUrl, "auth gateway base URL"),
    tv("app_auth_gateway_admin_url", options.values.appAuthGatewayAdminUrl, "auth gateway admin base URL"),
    tv("app_auth_gateway_admin_token", options.secrets.appAuthGatewayAdminToken, "auth gateway admin bearer token", false, true),
    tv("app_auth_app_slug_production", options.values.appAuthSlugProduction, "auth gateway app slug for production login"),
    tv("app_auth_app_slug_preview", options.values.appAuthSlugPreview, "auth gateway app slug for preview login"),
    tv("app_auth_base_url_production", options.values.appAuthBaseUrlProduction, "auth gateway base URL for production app registration"),
    tv("app_auth_base_url_preview", options.values.appAuthBaseUrlPreview, "auth gateway base URL for preview app registration"),
    tv("platform_notification_organization_id", options.request.organization_id, "platform notification organization scope"),
    tv("platform_notification_app_id", options.request.app_id, "platform notification app scope"),
    tv("deployment_environment", deploymentEnvironment, "deployment environment"),
    tv("d1_dev_cache_name", options.values.d1DevCacheName, "preview D1 cache database name"),
    tv("d1_prod_cache_name", options.values.d1ProdCacheName, "production D1 cache database name"),
    tv("r2_dev_media_cache_name", options.values.r2DevMediaCacheName, "preview R2 media cache bucket name"),
    tv("r2_prod_media_cache_name", options.values.r2ProdMediaCacheName, "production R2 media cache bucket name"),
    tv("app_build_version", options.buildVersion, "application build version"),
    tv("app_build_commit", options.buildCommit, "application build commit"),
    tv("app_build_timestamp", options.buildTimestamp, "application build timestamp"),
    tv("app_log_openobserve_organization_identifier", options.values.openObserveOrganizationIdentifier, "OpenObserve organization identifier"),
    tv("openobserve_sourcemap_upload_enabled", String(options.openObserveSourceMapUploadEnabled), "upload staged OpenObserve source maps", true),
    tv("openobserve_sourcemap_upload_url", options.values.openObserveSourceMapUploadUrl, "OpenObserve source-map upload API base URL"),
    tv("openobserve_sourcemap_upload_auth_scheme", options.values.openObserveSourceMapUploadAuthScheme, "OpenObserve source-map upload auth scheme"),
    tv(
      "openobserve_sourcemap_upload_auth_token_lookup_from_vault",
      String(options.values.openObserveSourceMapUploadAuthTokenLookupFromVault),
      "resolve OpenObserve source-map upload auth from Vault",
      true
    ),
    tv("openobserve_sourcemap_upload_auth_token_vault_mount", options.values.openObserveSourceMapUploadAuthTokenVaultMount, "OpenObserve source-map auth Vault mount"),
    tv("openobserve_sourcemap_upload_auth_token_vault_name", options.values.openObserveSourceMapUploadAuthTokenVaultName, "OpenObserve source-map auth Vault secret name"),
    tv("openobserve_sourcemap_upload_auth_token_vault_field", options.values.openObserveSourceMapUploadAuthTokenVaultField, "OpenObserve source-map auth Vault field"),
    tv("cloudflare_token", options.secrets.cloudflareToken, "Cloudflare API token", false, true),
    tv("cloudflare_account_id", options.secrets.cloudflareAccountId, "Cloudflare account id"),
    tv("cloudflare_zone_id", options.secrets.cloudflareZoneId, "Cloudflare zone id")
  ];
}

function tv(key: string, value: string, description: string, hcl = false, sensitive = false): TerraformVar {
  return { key, value, description, hcl, sensitive };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 46)
    .replace(/-+$/g, "");
}

function stripProtocolAndPath(value: string): string {
  return value.replace(/^https?:\/\//i, "").split("/")[0] || value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
