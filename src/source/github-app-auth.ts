import { createSign } from "node:crypto";
import { httpErrorMessage, httpJson } from "../lib/http.js";
import { JsonRecord, truncate } from "../lib/json.js";

const GITHUB_APP_AUTH_USER_AGENT = "suncoast-platform-deploy-executor";

type GitHubInstallationTokenResponse = {
  token?: string;
  expires_at?: string;
};

export type GitHubInstallationToken = {
  token: string;
  expiresAt: string;
};

function base64Url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizePrivateKey(value: string): string {
  return value.trim().replace(/\\n/g, "\n");
}

function createGitHubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iat: now - 60,
    exp: now + 540,
    iss: appId
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64Url(signer.sign(normalizePrivateKey(privateKey)))}`;
}

export async function createGitHubInstallationToken(options: {
  appId: string;
  installationId: string;
  privateKey: string;
  apiBase: string;
  timeoutMs: number;
}): Promise<GitHubInstallationToken> {
  const jwt = createGitHubAppJwt(options.appId, options.privateKey);
  const result = await httpJson<GitHubInstallationTokenResponse>(
    `${options.apiBase.replace(/\/+$/, "")}/app/installations/${encodeURIComponent(options.installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": GITHUB_APP_AUTH_USER_AGENT,
        "x-github-api-version": "2022-11-28"
      },
      timeoutMs: options.timeoutMs
    }
  );

  if (result.statusCode >= 400) {
    throw new Error(
      `GitHub App installation token request failed: HTTP ${result.statusCode} ${truncate(httpErrorMessage(result.payload, result.text), 700)}`
    );
  }

  const payload = result.payload as JsonRecord;
  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  const expiresAt = typeof payload.expires_at === "string" ? payload.expires_at.trim() : "";
  if (!token) {
    throw new Error("GitHub App installation token response did not include a token.");
  }

  return { token, expiresAt };
}
