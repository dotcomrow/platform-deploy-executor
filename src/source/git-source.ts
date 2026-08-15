import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { runCommand } from "../lib/command.js";

export type SourceCheckout = {
  sourceDir: string;
  cloneUrl: string;
  commit: string;
};

export function normalizeGitSource(sourceRepository: string): string {
  const value = sourceRepository.trim();
  if (/^[^/\s]+\/[^/\s]+$/.test(value)) {
    return `https://github.com/${value.replace(/\.git$/i, "")}.git`;
  }
  return value;
}

export function parseGitHubFullName(sourceRepository: string): string {
  const normalized = sourceRepository.trim().replace(/\.git$/i, "");
  const shorthand = normalized.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthand) return `${shorthand[1]}/${shorthand[2]}`;
  const ssh = normalized.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  try {
    const parsed = new URL(normalized);
    if (!parsed.hostname.toLowerCase().endsWith("github.com")) return "";
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    return owner && repo ? `${owner}/${repo}` : "";
  } catch {
    return "";
  }
}

function normalizeAuthenticatedGitSource(sourceRepository: string): string {
  const value = normalizeGitSource(sourceRepository);
  const ssh = value.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (!ssh) {
    return value;
  }
  return `https://github.com/${ssh[1]}/${ssh[2].replace(/\.git$/i, "")}.git`;
}

export async function checkoutSource(options: {
  sourceRepository: string;
  ref: string;
  targetDir: string;
  githubToken?: string;
  logFile?: string;
}): Promise<SourceCheckout> {
  await rm(options.targetDir, { recursive: true, force: true });
  await mkdir(dirname(options.targetDir), { recursive: true });

  const cloneUrl = options.githubToken
    ? normalizeAuthenticatedGitSource(options.sourceRepository)
    : normalizeGitSource(options.sourceRepository);
  const secrets = options.githubToken ? [options.githubToken] : [];
  const env: Record<string, string | undefined> = {};
  const gitConfigArgs: string[] = [];
  if (options.githubToken && cloneUrl.startsWith("https://github.com/")) {
    const header = Buffer.from(`x-access-token:${options.githubToken}`, "utf8").toString("base64");
    gitConfigArgs.push("-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${header}`);
    secrets.push(header);
  }
  const cloneArgs = [...gitConfigArgs, "clone", "--depth", "1", "--branch", options.ref, cloneUrl, options.targetDir];

  try {
    await runCommand("git", cloneArgs, { logFile: options.logFile, secrets, env });
  } catch {
    await rm(options.targetDir, { recursive: true, force: true });
    await mkdir(dirname(options.targetDir), { recursive: true });
    await runCommand("git", [...gitConfigArgs, "clone", cloneUrl, options.targetDir], { logFile: options.logFile, secrets, env });
    await runCommand("git", ["checkout", options.ref], { cwd: options.targetDir, logFile: options.logFile, secrets, env });
  }

  const commit = (await runCommand("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: options.targetDir,
    logFile: options.logFile,
    secrets
  })).stdout.trim();

  return { sourceDir: options.targetDir, cloneUrl, commit };
}
