import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { runCommand } from "../lib/command.js";

export type BuildMetadata = {
  version: string;
  commit: string;
  timestamp: string;
};

export function buildMetadata(ref: string, operationId: string, commit: string): BuildMetadata {
  const timestamp = new Date().toISOString();
  const safeRef = ref.replace(/[/@:\s]+/g, "-").replace(/[^A-Za-z0-9._-]+/g, "-");
  const suffix = operationId.replace(/-/g, "").slice(0, 10);
  const compactTime = timestamp.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "").replace("Z", "");
  return {
    version: `${safeRef}-${compactTime}-${suffix}`,
    commit,
    timestamp
  };
}

export async function buildShellArtifacts(options: {
  sourceDir: string;
  openObserveBrowserRumVersion: string;
  logFile: string;
  secrets?: string[];
}): Promise<void> {
  await runCommand("npm", ["ci", "--include=dev"], {
    cwd: options.sourceDir,
    env: {
      NODE_ENV: "development",
      NPM_CONFIG_PRODUCTION: "false"
    },
    logFile: options.logFile,
    secrets: options.secrets,
    timeoutMs: 20 * 60 * 1000
  });

  await installOpenObserveRumBundle(options);

  await runCommand("npm", ["run", "cf:build"], {
    cwd: options.sourceDir,
    logFile: options.logFile,
    secrets: options.secrets,
    timeoutMs: 30 * 60 * 1000
  });

  const terraformOpenNext = join(options.sourceDir, "terraform", ".open-next");
  await rm(terraformOpenNext, { recursive: true, force: true });
  await mkdir(terraformOpenNext, { recursive: true });
  await runCommand("npx", ["wrangler", "deploy", "--dry-run", "--outdir", "terraform/.open-next", "--config", "wrangler.jsonc", "--env", "production"], {
    cwd: options.sourceDir,
    env: { WRANGLER_LOG: "error" },
    logFile: options.logFile,
    secrets: options.secrets,
    timeoutMs: 10 * 60 * 1000
  });

  const assetsSource = join(options.sourceDir, ".open-next", "assets");
  const assetsTarget = join(terraformOpenNext, "assets");
  await rm(assetsTarget, { recursive: true, force: true });
  await cp(assetsSource, assetsTarget, { recursive: true });
}

async function installOpenObserveRumBundle(options: {
  sourceDir: string;
  openObserveBrowserRumVersion: string;
  logFile: string;
  secrets?: string[];
}): Promise<void> {
  const version = options.openObserveBrowserRumVersion || "0.3.1";
  const cacheDir = config.openObserveBrowserRumCacheDir;
  const destinationDir = join(options.sourceDir, "public", "openobserve");
  const destinationFile = join(destinationDir, "openobserve-rum.js");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(destinationDir, { recursive: true });

  let tarball = await findRumTarball(cacheDir, version);
  if (!tarball) {
    await runCommand("npm", ["pack", `@openobserve/browser-rum@${version}`, "--pack-destination", cacheDir, "--silent"], {
      cwd: options.sourceDir,
      logFile: options.logFile,
      secrets: options.secrets,
      timeoutMs: 5 * 60 * 1000
    });
    tarball = await findRumTarball(cacheDir, version);
  }
  if (!tarball) {
    throw new Error(`Failed to cache @openobserve/browser-rum@${version}.`);
  }

  const extractDir = join(cacheDir, "extract", version);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  await runCommand("tar", ["-xzf", tarball, "-C", extractDir], {
    logFile: options.logFile,
    secrets: options.secrets
  });

  const bundle = join(extractDir, "package", "bundle", "openobserve-rum.js");
  await stat(bundle);
  await cp(bundle, destinationFile);
}

async function findRumTarball(cacheDir: string, version: string): Promise<string> {
  try {
    const files = await readdir(cacheDir);
    const exact = files.find((file) => file.endsWith(".tgz") && file.includes(version));
    return exact ? join(cacheDir, exact) : "";
  } catch {
    return "";
  }
}
