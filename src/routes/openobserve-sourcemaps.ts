import express, { Request, Response } from "express";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { enforceInternalAuth } from "../auth/internal-auth.js";
import { uploadOpenObserveSourceMapArchive } from "../providers/openobserve-sourcemaps.js";

const uploadQuerySchema = z.object({
  env: z.enum(["preview", "production"]),
  organization: z.string().optional().default(config.defaultOpenObserveSourceMapOrg),
  service: z.string().min(1),
  version: z.string().min(1),
});

export const openObserveSourceMapUploadBody = express.raw({
  limit: config.openObserveSourceMapDirectUploadMaxBytes,
  type: ["application/zip", "application/octet-stream"],
});

export async function handleOpenObserveSourceMapUpload(
  req: Request,
  res: Response,
): Promise<void> {
  await enforceInternalAuth(req);

  const query = uploadQuerySchema.parse({
    env: req.query.env,
    organization: req.query.organization,
    service: req.query.service,
    version: req.query.version,
  });

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (body.byteLength <= 0) {
    throw Object.assign(new Error("OpenObserve source-map upload body is empty."), { status: 400 });
  }
  if (body.byteLength > config.openObserveSourceMapDirectUploadMaxBytes) {
    throw Object.assign(new Error("OpenObserve source-map upload body is too large."), { status: 413 });
  }

  await mkdir(config.workspaceRoot, { recursive: true });
  const operationDir = await mkdtemp(join(config.workspaceRoot, "openobserve-sourcemaps-"));
  const archivePath = join(operationDir, "sourcemaps.zip");
  const logFile = join(operationDir, "openobserve-sourcemaps.log");

  try {
    await writeFile(archivePath, body);
    const upload = await uploadOpenObserveSourceMapArchive({
      archivePath,
      identity: {
        environment: query.env,
        organization: query.organization,
        service: query.service,
        version: query.version,
      },
      logFile,
      settings: {
        authScheme: config.defaultOpenObserveSourceMapUploadAuthScheme,
        authTokenLookupFromVault: config.defaultOpenObserveSourceMapUploadAuthTokenLookupFromVault,
        authTokenVaultField: config.defaultOpenObserveSourceMapUploadAuthTokenVaultField,
        authTokenVaultMount: config.defaultOpenObserveSourceMapUploadAuthTokenVaultMount,
        authTokenVaultName: config.defaultOpenObserveSourceMapUploadAuthTokenVaultName,
        uploadBaseUrl: config.defaultOpenObserveSourceMapUploadUrl,
      },
    });

    res.status(200).json({
      ok: true,
      service: "platform-deploy-executor",
      upload,
    });
  } finally {
    await rm(operationDir, { recursive: true, force: true });
  }
}
