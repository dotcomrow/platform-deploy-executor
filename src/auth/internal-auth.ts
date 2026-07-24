import { timingSafeEqual } from "node:crypto";
import { Request } from "express";
import { config } from "../config.js";
import { asString } from "../lib/json.js";
import { resolveInternalToken } from "../lib/vault.js";

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function enforceInternalAuth(req: Request): Promise<void> {
  if (!config.authRequired) {
    return;
  }

  const expected = await resolveInternalToken();
  if (!expected) {
    throw Object.assign(new Error("Internal auth token is not configured."), { status: 503 });
  }

  const actual = asString(req.header("authorization"));
  if (!safeEqual(actual, `Bearer ${expected}`)) {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  }
}
