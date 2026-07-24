import { z } from "zod";
import { asBoolean } from "./lib/json.js";

const envSchema = z.object({
  PORT: z.string().default("8080"),
  TRUST_PROXY_HOPS: z.string().default("1"),
  RATE_WINDOW_MS: z.string().default("60000"),
  RATE_MAX: z.string().default("120"),
  REQUEST_TIMEOUT_MS: z.string().default("15000"),
  AUTH_REQUIRED: z.string().default("true"),
  EXECUTOR_MODE: z.enum(["dry_run", "terraform_cloud", "local_terraform"]).default("dry_run"),
  INTERNAL_TOKEN: z.string().default(""),
  INTERNAL_TOKEN_VAULT_PATH: z.string().default("secret/data/platform-deploy-service"),
  INTERNAL_TOKEN_VAULT_KEY: z.string().default("token"),
  VAULT_ADDR: z.string().default("http://vault.vault.svc.cluster.local:8200"),
  VAULT_TOKEN_FILE: z.string().default("/vault-secrets/vault-token"),
  TOKEN_CACHE_SECONDS: z.string().default("300"),
  OPENAPI_SERVER_URL: z.string().default("http://platform-deploy-executor.directus.svc.cluster.local:8080")
});

const parsed = envSchema.parse(process.env);

export const config = {
  port: Math.max(1, Math.min(65535, Number(parsed.PORT) || 8080)),
  trustProxyHops: Math.max(0, Number(parsed.TRUST_PROXY_HOPS) || 1),
  rateWindowMs: Math.max(1000, Number(parsed.RATE_WINDOW_MS) || 60_000),
  rateMax: Math.max(1, Number(parsed.RATE_MAX) || 120),
  requestTimeoutMs: Math.max(1000, Number(parsed.REQUEST_TIMEOUT_MS) || 15_000),
  authRequired: asBoolean(parsed.AUTH_REQUIRED, true),
  executorMode: parsed.EXECUTOR_MODE,
  internalToken: parsed.INTERNAL_TOKEN,
  internalTokenVaultPath: parsed.INTERNAL_TOKEN_VAULT_PATH,
  internalTokenVaultKey: parsed.INTERNAL_TOKEN_VAULT_KEY,
  vaultAddr: parsed.VAULT_ADDR.replace(/\/+$/, ""),
  vaultTokenFile: parsed.VAULT_TOKEN_FILE,
  tokenCacheSeconds: Math.max(5, Number(parsed.TOKEN_CACHE_SECONDS) || 300),
  openApiServerUrl: parsed.OPENAPI_SERVER_URL
};

export type ExecutorMode = typeof config.executorMode;
