import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import { asRecord, asString, JsonRecord, truncate } from "./json.js";
import { httpJson } from "./http.js";

type VaultCacheEntry = {
  expiresAt: number;
  value: string;
};

const vaultCache = new Map<string, VaultCacheEntry>();

async function vaultToken(): Promise<string> {
  const token = await readFile(config.vaultTokenFile, "utf8");
  return token.trim();
}

export async function vaultValue(path: string, key: string): Promise<string> {
  const cacheKey = `${path}#${key}`;
  const cached = vaultCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const token = await vaultToken();
  const normalizedPath = path.replace(/^\/+/, "").replace(/^v1\//, "");
  const result = await httpJson<JsonRecord>(`${config.vaultAddr}/v1/${normalizedPath}`, {
    headers: { "x-vault-token": token },
    timeoutMs: config.requestTimeoutMs
  });
  if (result.statusCode >= 400) {
    throw new Error(`Vault read ${path} failed: ${result.statusCode} ${truncate(result.text, 500)}`);
  }

  const payload = asRecord(result.payload) ?? {};
  const data = asRecord(payload.data) ?? {};
  const nested = asRecord(data.data);
  const value = asString((nested ?? data)[key]);
  if (!value) {
    throw new Error(`Vault read ${path} did not return key ${key}`);
  }
  vaultCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + config.tokenCacheSeconds * 1000
  });
  return value;
}

export async function optionalVaultValue(path: string, keys: string[]): Promise<string> {
  if (!path || !keys.length) {
    return "";
  }
  for (const key of keys) {
    try {
      return await vaultValue(path, key);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("failed: 404")) {
        return "";
      }
      if (!message.includes("did not return key")) {
        throw error;
      }
    }
  }
  return "";
}

export async function resolveInternalToken(): Promise<string> {
  if (config.internalToken) {
    return config.internalToken;
  }
  if (!config.internalTokenVaultPath) {
    return "";
  }
  return vaultValue(config.internalTokenVaultPath, config.internalTokenVaultKey);
}
