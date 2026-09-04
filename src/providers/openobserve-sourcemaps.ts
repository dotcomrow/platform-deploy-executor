import { randomUUID } from "node:crypto";
import { appendFile, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { request as undiciRequest } from "undici";
import { config } from "../config.js";
import { truncate } from "../lib/json.js";
import { vaultValue } from "../lib/vault.js";
import { BuildMetadata } from "../build/shell-build.js";
import { DeployRequest, DeploymentTarget } from "../steps/types.js";
import { ResolvedDeployValues } from "./deploy-values.js";

export type OpenObserveSourceMapUploadResult = {
  uploaded: true;
  archive_bytes: number;
  archive_path: string;
  environment: string;
  organization: string;
  service: string;
  upload_url: string;
  verification_status: number;
  version: string;
};

export async function uploadOpenObserveSourceMaps(options: {
  archivePath: string;
  logFile: string;
  metadata: BuildMetadata;
  request: DeployRequest;
  target: DeploymentTarget;
  values: ResolvedDeployValues;
}): Promise<OpenObserveSourceMapUploadResult> {
  const archiveStats = await stat(options.archivePath);
  if (!archiveStats.isFile()) {
    throw new Error(`OpenObserve source-map archive is not a file: ${options.archivePath}`);
  }
  if (archiveStats.size <= 0) {
    throw new Error(`OpenObserve source-map archive is empty: ${options.archivePath}`);
  }

  const uploadBaseUrl = trimTrailingSlash(options.values.openObserveSourceMapUploadUrl);
  if (!uploadBaseUrl) {
    throw new Error("OpenObserve source-map upload URL is empty.");
  }
  if (!options.values.openObserveSourceMapUploadAuthTokenLookupFromVault) {
    throw new Error("Executor OpenObserve source-map upload requires Vault-backed auth token lookup.");
  }

  const organization = options.values.openObserveOrganizationIdentifier || config.defaultOpenObserveSourceMapOrg;
  const service = options.values.projectName;
  const environment = options.target === "production" ? "production" : "preview";
  const version = options.metadata.version;
  const authToken = await vaultValue(
    vaultKv2DataPath(
      options.values.openObserveSourceMapUploadAuthTokenVaultMount,
      options.values.openObserveSourceMapUploadAuthTokenVaultName
    ),
    options.values.openObserveSourceMapUploadAuthTokenVaultField
  );

  const sourceMapsUrl = `${uploadBaseUrl}/api/${encodeURIComponent(organization)}/sourcemaps`;
  const archive = await readFile(options.archivePath);
  const multipart = multipartBody(
    {
      service,
      env: environment,
      version
    },
    "file",
    basename(options.archivePath),
    archive
  );

  const upload = await openObserveRequest("POST", sourceMapsUrl, {
    accept: "application/json",
    authorization: authorizationHeader(authToken, options.values.openObserveSourceMapUploadAuthScheme),
    "content-length": String(multipart.body.length),
    "content-type": `multipart/form-data; boundary=${multipart.boundary}`
  }, multipart.body);

  if (![200, 201, 204].includes(upload.statusCode)) {
    throw new Error(openObserveError("Failed to upload OpenObserve source maps", upload));
  }

  const verifyUrl = `${sourceMapsUrl}?${new URLSearchParams({ service, env: environment, version }).toString()}`;
  const verification = await openObserveRequest("GET", verifyUrl, {
    accept: "application/json",
    authorization: authorizationHeader(authToken, options.values.openObserveSourceMapUploadAuthScheme)
  });
  if (verification.statusCode !== 200) {
    throw new Error(openObserveError("OpenObserve accepted source maps but verification failed", verification));
  }

  const trimmed = verification.body.trim();
  if (trimmed === "[]") {
    throw new Error(`OpenObserve source-map verification returned no records for service=${service} env=${environment} version=${version}.`);
  }

  await appendFile(
    options.logFile,
    `[executor] ${new Date().toISOString()} uploaded OpenObserve source maps service=${service} env=${environment} version=${version} bytes=${archiveStats.size}\n`,
    "utf8"
  );

  return {
    uploaded: true,
    archive_bytes: archiveStats.size,
    archive_path: options.archivePath,
    environment,
    organization,
    service,
    upload_url: uploadBaseUrl,
    verification_status: verification.statusCode,
    version
  };
}

function authorizationHeader(token: string, scheme: string): string {
  const normalizedToken = token.trim();
  if (/^(basic|bearer)\s+/i.test(normalizedToken)) {
    return normalizedToken;
  }
  const normalizedScheme = scheme.trim().toLowerCase() === "bearer" ? "Bearer" : "Basic";
  return `${normalizedScheme} ${normalizedToken}`;
}

function multipartBody(fields: Record<string, string>, fileField: string, fileName: string, fileContent: Buffer): { body: Buffer; boundary: string } {
  const boundary = `----suncoast-openobserve-sourcemaps-${randomUUID().replace(/-/g, "")}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\n`, "utf8"),
      Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`, "utf8"),
      Buffer.from(value, "utf8"),
      Buffer.from("\r\n", "utf8")
    );
  }
  chunks.push(
    Buffer.from(`--${boundary}\r\n`, "utf8"),
    Buffer.from(`Content-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\n`, "utf8"),
    Buffer.from("Content-Type: application/zip\r\n\r\n", "utf8"),
    fileContent,
    Buffer.from("\r\n", "utf8"),
    Buffer.from(`--${boundary}--\r\n`, "utf8")
  );
  return { body: Buffer.concat(chunks), boundary };
}

async function openObserveRequest(method: "GET" | "POST", url: string, headers: Record<string, string>, body?: Buffer): Promise<{ body: string; headers: Record<string, string>; statusCode: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(config.requestTimeoutMs, 60_000));
  try {
    const response = await undiciRequest(url, {
      method,
      headers,
      body,
      signal: controller.signal
    });
    const responseBody = await response.body.text();
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === "string") responseHeaders[key.toLowerCase()] = value;
    }
    return { body: responseBody, headers: responseHeaders, statusCode: response.statusCode };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`OpenObserve source-map request failed before response for ${method} ${url}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

function openObserveError(message: string, response: { body: string; headers: Record<string, string>; statusCode: number }): string {
  const details = ["x-request-id", "cf-ray", "server"]
    .map((header) => response.headers[header] ? `${header}=${response.headers[header]}` : "")
    .filter(Boolean);
  const suffix = details.length ? ` (${details.join(", ")})` : "";
  return `${message} (HTTP ${response.statusCode})${suffix}. Response body: ${truncate(response.body.trim(), 2000)}`;
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function vaultKv2DataPath(mount: string, name: string): string {
  const cleanMount = mount.trim().replace(/^\/+|\/+$/g, "") || "secret";
  const cleanName = name.trim().replace(/^\/+/, "");
  return `${cleanMount}/data/${cleanName}`;
}
