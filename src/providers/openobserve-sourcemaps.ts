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
  cleanup: OpenObserveSourceMapCleanupResult;
  environment: string;
  organization: string;
  service: string;
  upload_url: string;
  verification_status: number;
  version: string;
};

export type OpenObserveSourceMapCleanupResult = {
  cutoff_iso: string;
  deleted_versions: string[];
  enabled: boolean;
  error_message?: string;
  failed_deletes: Array<{
    error_message: string;
    status_code: number;
    version: string;
  }>;
  kept_current_version: string;
  kept_recent_versions: string[];
  records_seen: number;
  retention_days: number;
  skipped_versions_without_timestamp: string[];
};

type ListedSourceMapRecord = {
  createdAtMs: number | null;
  env: string | null;
  service: string | null;
  version: string | null;
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
  const authorization = authorizationHeader(authToken, options.values.openObserveSourceMapUploadAuthScheme);
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
    authorization,
    "content-length": String(multipart.body.length),
    "content-type": `multipart/form-data; boundary=${multipart.boundary}`
  }, multipart.body);

  if (![200, 201, 204].includes(upload.statusCode)) {
    throw new Error(openObserveError("Failed to upload OpenObserve source maps", upload));
  }

  const verifyUrl = `${sourceMapsUrl}?${new URLSearchParams({ service, env: environment, version }).toString()}`;
  const verification = await openObserveRequest("GET", verifyUrl, {
    accept: "application/json",
    authorization
  });
  if (verification.statusCode !== 200) {
    throw new Error(openObserveError("OpenObserve accepted source maps but verification failed", verification));
  }

  const trimmed = verification.body.trim();
  if (trimmed === "[]") {
    throw new Error(`OpenObserve source-map verification returned no records for service=${service} env=${environment} version=${version}.`);
  }

  const cleanup = await cleanupOldOpenObserveSourceMaps({
    authorization,
    environment,
    logFile: options.logFile,
    service,
    sourceMapsUrl,
    version
  });

  await appendFile(
    options.logFile,
    `[executor] ${new Date().toISOString()} uploaded OpenObserve source maps service=${service} env=${environment} version=${version} bytes=${archiveStats.size} cleanup_deleted_versions=${cleanup.deleted_versions.length} cleanup_failed_deletes=${cleanup.failed_deletes.length}\n`,
    "utf8"
  );

  return {
    uploaded: true,
    archive_bytes: archiveStats.size,
    archive_path: options.archivePath,
    cleanup,
    environment,
    organization,
    service,
    upload_url: uploadBaseUrl,
    verification_status: verification.statusCode,
    version
  };
}

async function cleanupOldOpenObserveSourceMaps(options: {
  authorization: string;
  environment: string;
  logFile: string;
  service: string;
  sourceMapsUrl: string;
  version: string;
}): Promise<OpenObserveSourceMapCleanupResult> {
  const retentionDays = config.defaultOpenObserveSourceMapRetentionDays;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const result: OpenObserveSourceMapCleanupResult = {
    cutoff_iso: new Date(cutoffMs).toISOString(),
    deleted_versions: [],
    enabled: config.defaultOpenObserveSourceMapCleanupEnabled,
    failed_deletes: [],
    kept_current_version: options.version,
    kept_recent_versions: [],
    records_seen: 0,
    retention_days: retentionDays,
    skipped_versions_without_timestamp: []
  };

  if (!result.enabled) {
    return result;
  }

  try {
    const listUrl = `${options.sourceMapsUrl}?${new URLSearchParams({ service: options.service, env: options.environment }).toString()}`;
    const list = await openObserveRequest("GET", listUrl, {
      accept: "application/json",
      authorization: options.authorization
    });
    if (list.statusCode !== 200) {
      throw new Error(openObserveError("Failed to list OpenObserve source maps for cleanup", list));
    }

    const records = parseSourceMapRecords(list.body)
      .filter((record) => (record.service ?? options.service) === options.service)
      .filter((record) => (record.env ?? options.environment) === options.environment)
      .filter((record) => Boolean(record.version));
    result.records_seen = records.length;

    const versions = new Map<string, { newestCreatedAtMs: number | null }>();
    for (const record of records) {
      if (!record.version) continue;
      const existing = versions.get(record.version);
      const currentNewest = existing?.newestCreatedAtMs ?? null;
      const nextNewest = record.createdAtMs === null
        ? currentNewest
        : currentNewest === null
          ? record.createdAtMs
          : Math.max(currentNewest, record.createdAtMs);
      versions.set(record.version, { newestCreatedAtMs: nextNewest });
    }

    for (const [candidateVersion, candidate] of versions) {
      if (candidateVersion === options.version) {
        continue;
      }
      if (candidate.newestCreatedAtMs === null) {
        result.skipped_versions_without_timestamp.push(candidateVersion);
        continue;
      }
      if (candidate.newestCreatedAtMs >= cutoffMs) {
        result.kept_recent_versions.push(candidateVersion);
        continue;
      }

      const deleteUrl = `${options.sourceMapsUrl}?${new URLSearchParams({
        service: options.service,
        env: options.environment,
        version: candidateVersion
      }).toString()}`;
      const deletion = await openObserveRequest("DELETE", deleteUrl, {
        accept: "application/json",
        authorization: options.authorization
      });
      if ([200, 202, 204].includes(deletion.statusCode)) {
        result.deleted_versions.push(candidateVersion);
      } else {
        result.failed_deletes.push({
          error_message: openObserveError("Failed to delete old OpenObserve source maps", deletion),
          status_code: deletion.statusCode,
          version: candidateVersion
        });
      }
    }

    await appendFile(
      options.logFile,
      `[executor] ${new Date().toISOString()} cleaned OpenObserve source maps service=${options.service} env=${options.environment} retention_days=${retentionDays} deleted_versions=${result.deleted_versions.length} failed_deletes=${result.failed_deletes.length} skipped_without_timestamp=${result.skipped_versions_without_timestamp.length}\n`,
      "utf8"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.error_message = message;
    await appendFile(
      options.logFile,
      `[executor] ${new Date().toISOString()} OpenObserve source-map cleanup failed after upload; continuing: ${message}\n`,
      "utf8"
    );
  }

  return result;
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

async function openObserveRequest(method: "DELETE" | "GET" | "POST", url: string, headers: Record<string, string>, body?: Buffer): Promise<{ body: string; headers: Record<string, string>; statusCode: number }> {
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

function parseSourceMapRecords(body: string): ListedSourceMapRecord[] {
  const parsed = JSON.parse(body) as unknown;
  const rows = sourceMapRecordRows(parsed);
  return rows.map((row) => ({
    createdAtMs: parseTimestampMs(row.created_at)
      ?? parseTimestampMs(row.createdAt)
      ?? parseTimestampMs(row.created)
      ?? parseTimestampMs(row.uploaded_at)
      ?? parseTimestampMs(row.uploadedAt)
      ?? parseTimestampMs(row.updated_at)
      ?? parseTimestampMs(row.updatedAt)
      ?? parseTimestampMs(row.timestamp)
      ?? parseTimestampMs(row._timestamp),
    env: stringValue(row.env ?? row.environment),
    service: stringValue(row.service),
    version: stringValue(row.version)
  }));
}

function sourceMapRecordRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) {
    return [];
  }

  for (const key of ["data", "records", "list", "sourcemaps", "source_maps", "sourceMaps"]) {
    const child = value[key];
    if (Array.isArray(child)) {
      return child.filter(isRecord);
    }
  }

  return [];
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return normalizeTimestampNumber(value);
  }
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/u.test(trimmed)) {
    return normalizeTimestampNumber(Number(trimmed));
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestampNumber(value: number): number {
  if (value > 100_000_000_000_000) {
    return Math.floor(value / 1000);
  }
  if (value > 100_000_000_000) {
    return Math.floor(value);
  }
  if (value > 1_000_000_000) {
    return Math.floor(value * 1000);
  }
  return Math.floor(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
