import {
  apiErrorResponseSchema,
  commandAcknowledgementSchema,
  wireAcceptRematchResponseSchema,
  wireCreateDevSessionResponseSchema,
  wireCreateGameResponseSchema,
  wireCreateInvitationResponseSchema,
  wireGameStateResponseSchema,
  wireJoinInvitationResponseSchema,
  wireRequestRematchResponseSchema,
  wireSubmitWordResponseSchema,
  type WireCreateInvitationResponse,
  type WireGameStateResponse,
  type WireSubmitWordResponse,
} from "@anagrams/shared-types";
import { z } from "zod";
const API = "/api/v1";

export interface SessionUser {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly wins: number;
}

const userSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email().nullable(),
  wins: z.number().int().nonnegative(),
});
const meSchema = z.object({ user: userSchema });
const magicRequestSchema = z.object({
  accepted: z.literal(true),
  developmentMagicLink: z.string().url().optional(),
});
const magicConsumeSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    email: z.string().email(),
  }),
  continueTo: z.string().nullable(),
});

interface RuntimeSchema<T> {
  safeParse(
    input: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

export class ApiClientError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function createIdentity(displayName: string): Promise<void> {
  await request("/dev/sessions", wireCreateDevSessionResponseSchema, {
    method: "POST",
    body: { displayName },
    csrf: false,
  });
}

export async function getMe(): Promise<SessionUser | null> {
  try {
    return (await request("/me", meSchema)).user;
  } catch (caught) {
    if (caught instanceof ApiClientError && caught.code === "UNAUTHENTICATED")
      return null;
    throw caught;
  }
}

export async function requestMagicLink(input: {
  readonly email: string;
  readonly displayName?: string;
  readonly continuePath?: string;
}): Promise<{ readonly developmentMagicLink?: string }> {
  return request("/auth/magic-links", magicRequestSchema, {
    method: "POST",
    body: input,
    csrf: false,
  });
}

export async function consumeMagicLink(token: string): Promise<void> {
  await request("/auth/magic-links/consume", magicConsumeSchema, {
    method: "POST",
    body: { token },
    csrf: false,
  });
}

export async function logout(): Promise<void> {
  await request("/auth/logout", commandAcknowledgementSchema, {
    method: "POST",
    body: {},
  });
}

export async function createGame(): Promise<string> {
  const result = await request("/games", wireCreateGameResponseSchema, {
    method: "POST",
    body: {},
  });
  return result.gameId;
}

export async function createSoloGame(): Promise<string> {
  const result = await request("/games/solo", wireCreateGameResponseSchema, {
    method: "POST",
    body: {},
  });
  return result.gameId;
}

export function createInvitation(
  gameId: string,
): Promise<WireCreateInvitationResponse> {
  return request(
    `/games/${encodeURIComponent(gameId)}/invitations`,
    wireCreateInvitationResponseSchema,
    { method: "POST", body: {} },
  );
}

export async function joinInvitation(token: string): Promise<string> {
  const result = await request(
    "/invitations/join",
    wireJoinInvitationResponseSchema,
    { method: "POST", body: { token } },
  );
  return result.gameId;
}

export function getGame(gameId: string): Promise<WireGameStateResponse> {
  return request(
    `/games/${encodeURIComponent(gameId)}`,
    wireGameStateResponseSchema,
  );
}

export async function markReady(
  gameId: string,
  version: number,
): Promise<void> {
  await command(gameId, "/ready", { expectedVersion: version });
}

export async function startRound(
  gameId: string,
  version: number,
): Promise<void> {
  await command(gameId, "/round/start", { expectedVersion: version });
}

export async function finishRound(
  gameId: string,
  version: number,
): Promise<void> {
  await command(gameId, "/round/finish", { expectedVersion: version });
}

export function submitWord(
  gameId: string,
  word: string,
): Promise<WireSubmitWordResponse> {
  const idempotencyKey = crypto.randomUUID();
  return request(
    `/games/${encodeURIComponent(gameId)}/round/submit`,
    wireSubmitWordResponseSchema,
    {
      method: "POST",
      body: { word, idempotencyKey },
      headers: { "Idempotency-Key": idempotencyKey },
    },
  );
}

export async function requestRematch(gameId: string): Promise<string | null> {
  const result = await request(
    `/games/${encodeURIComponent(gameId)}/rematch`,
    wireRequestRematchResponseSchema,
    { method: "POST", body: {} },
  );
  return result.requestId;
}

export async function acceptRematch(
  gameId: string,
  requestId: string,
): Promise<string> {
  const result = await request(
    `/games/${encodeURIComponent(gameId)}/rematch/accept`,
    wireAcceptRematchResponseSchema,
    { method: "POST", body: { requestId } },
  );
  return result.gameId;
}

async function command(
  gameId: string,
  suffix: string,
  body: unknown,
): Promise<void> {
  await request(
    `/games/${encodeURIComponent(gameId)}${suffix}`,
    commandAcknowledgementSchema,
    { method: "POST", body },
  );
}

interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly csrf?: boolean;
}

async function request<T>(
  path: string,
  schema: RuntimeSchema<T>,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.csrf !== false && options.method === "POST") {
    const token = readCookie("anagrams_csrf");
    if (token) headers["X-CSRF-Token"] = token;
  }
  const init: RequestInit = {
    method: options.method ?? "GET",
    credentials: "include",
    headers,
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(`${API}${path}`, init);
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.safeParse(payload);
    if (parsed.success)
      throw new ApiClientError(
        parsed.data.error.code,
        parsed.data.error.message,
        response.status,
      );
    throw new ApiClientError(
      "UNEXPECTED_RESPONSE",
      "The game service could not complete that request.",
      response.status,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    throw new ApiClientError(
      "INVALID_RESPONSE",
      "The game service returned an unexpected response.",
      502,
    );
  return parsed.data;
}

function readCookie(name: string): string | undefined {
  const prefix = `${encodeURIComponent(name)}=`;
  const item = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : undefined;
}
