import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export const SESSION_COOKIE = "anagrams_session";
export const CSRF_COOKIE = "anagrams_csrf";
export function opaqueToken(): string {
  return randomBytes(32).toString("base64url");
}
export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
export function safeEqualHash(raw: string, expected: string): boolean {
  const actual = Buffer.from(tokenHash(raw), "hex");
  const target = Buffer.from(expected, "hex");
  return actual.length === target.length && timingSafeEqual(actual, target);
}
export function requestOrigin(request: FastifyRequest): string | undefined {
  const value = request.headers.origin;
  return typeof value === "string" ? value : undefined;
}
