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
const API = "/api/v1";

export interface SessionUser {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly wins: number;
  readonly username: string | null;
  readonly hasPassword: boolean;
}

export interface FriendSummary {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
}

export interface FriendRequestSummary {
  readonly id: string;
  readonly user: FriendSummary;
}

export interface FriendsResponse {
  readonly friends: readonly FriendSummary[];
  readonly incomingRequests: readonly FriendRequestSummary[];
  readonly outgoingRequests: readonly FriendRequestSummary[];
}

export interface FriendSearchResponse {
  readonly user: FriendSummary | null;
  readonly relationship: "none" | "friend" | "incoming" | "outgoing" | "self";
}

export interface FriendGameInvitation {
  readonly id: string;
  readonly gameId: string;
  readonly inviter: FriendSummary;
  readonly expiresAt: string;
}

interface MagicRequestResponse {
  readonly accepted: true;
  readonly developmentMagicLink?: string;
}
interface MagicConsumeResponse {
  readonly user: { readonly id: string; readonly displayName: string; readonly email: string };
  readonly continueTo: string | null;
}
export interface FriendInvitationCreated {
  readonly invite: {
    readonly id: string;
    readonly gameId: string;
    readonly friendUserId: string;
    readonly expiresAt: string;
  };
}
const meSchema = runtimeSchema<{ readonly user: SessionUser }>((value) => {
  const user = record(record(value)?.user);
  return Boolean(
    user &&
      typeof user.id === "string" &&
      typeof user.displayName === "string" &&
      (typeof user.email === "string" || user.email === null) &&
      typeof user.wins === "number" &&
      (typeof user.username === "string" || user.username === null) &&
      typeof user.hasPassword === "boolean",
  );
});
const magicRequestSchema = runtimeSchema<MagicRequestResponse>((value) => {
  const item = record(value);
  return (
    item?.accepted === true &&
      (item.developmentMagicLink === undefined ||
        typeof item.developmentMagicLink === "string")
  );
});
const magicConsumeSchema = runtimeSchema<MagicConsumeResponse>((value) => {
  const item = record(value);
  const user = record(item?.user);
  return Boolean(
    user &&
      typeof user.id === "string" &&
      typeof user.displayName === "string" &&
      typeof user.email === "string" &&
      (item?.continueTo === null || typeof item?.continueTo === "string"),
  );
});
const passwordAuthSchema = runtimeSchema<{ readonly user: { readonly id: string } }>((value) => {
  const user = record(record(value)?.user);
  return Boolean(user && typeof user.id === "string");
});
const acceptedSchema = runtimeSchema<{ readonly accepted: true }>((value) => record(value)?.accepted === true);
const friend = (value: unknown): value is FriendSummary => {
  const item = record(value);
  return Boolean(
    item &&
      typeof item.userId === "string" &&
      typeof item.username === "string" &&
      typeof item.displayName === "string",
  );
};
const friendRequest = (value: unknown): value is FriendRequestSummary => {
  const item = record(value);
  return Boolean(item && typeof item.id === "string" && friend(item.user));
};
const friendsSchema = runtimeSchema<FriendsResponse>((value) => {
  const item = record(value);
  return Boolean(
    item &&
      Array.isArray(item.friends) &&
      item.friends.every(friend) &&
      Array.isArray(item.incomingRequests) &&
      item.incomingRequests.every(friendRequest) &&
      Array.isArray(item.outgoingRequests) &&
      item.outgoingRequests.every(friendRequest),
  );
});
const friendSearchSchema = runtimeSchema<FriendSearchResponse>((value) => {
  const item = record(value);
  return Boolean(
    item &&
      (item.user === null || friend(item.user)) &&
      ["none", "friend", "incoming", "outgoing", "self"].includes(
        String(item.relationship),
      ),
  );
});
const friendInvitationsSchema = runtimeSchema<{
  readonly invitations: readonly FriendGameInvitation[];
}>((value) => {
  const item = record(value);
  return Boolean(
    item &&
      Array.isArray(item.invitations) &&
      item.invitations.every((entry) => {
        const invitation = record(entry);
        return Boolean(
          invitation &&
            typeof invitation.id === "string" &&
            typeof invitation.gameId === "string" &&
            typeof invitation.expiresAt === "string" &&
            friend(invitation.inviter),
        );
      }),
  );
});
const outgoingFriendInvitationSchema = runtimeSchema<{
  readonly friend: FriendSummary | null;
  readonly status: "pending" | "accepted" | "declined" | null;
}>((value) => {
  const item = record(value);
  return Boolean(
    item &&
      (item.friend === null || friend(item.friend)) &&
      (item.status === null ||
        (typeof item.status === "string" &&
          ["pending", "accepted", "declined"].includes(item.status))),
  );
});
const joinedFriendInvitationSchema = runtimeSchema<{ readonly gameId: string }>(
  (value) => typeof record(value)?.gameId === "string",
);
const usernameResponseSchema = runtimeSchema<{
  readonly user: { readonly username: string };
}>((value) => typeof record(record(value)?.user)?.username === "string");
const friendInvitationCreatedSchema = runtimeSchema<FriendInvitationCreated>(
  (value) => {
    const invite = record(record(value)?.invite);
    return Boolean(
      invite &&
        typeof invite.id === "string" &&
        typeof invite.gameId === "string" &&
        typeof invite.friendUserId === "string" &&
        typeof invite.expiresAt === "string",
    );
  },
);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function runtimeSchema<T>(guard: (value: unknown) => boolean): RuntimeSchema<T> {
  return {
    safeParse: (value) =>
      guard(value)
        ? { success: true, data: value as T }
        : { success: false },
  };
}

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
  readonly username?: string;
  readonly continuePath?: string;
}): Promise<{ readonly developmentMagicLink?: string }> {
  return request("/auth/magic-links", magicRequestSchema, {
    method: "POST",
    body: input,
    csrf: false,
  });
}

export async function signupWithPassword(input: {
  readonly displayName: string;
  readonly username: string;
  readonly email: string;
  readonly password: string;
}): Promise<void> {
  await request("/auth/password/signup", passwordAuthSchema, { method: "POST", body: input, csrf: false });
}

export async function loginWithPassword(email: string, password: string): Promise<void> {
  await request("/auth/password/login", passwordAuthSchema, { method: "POST", body: { email, password }, csrf: false });
}

export async function requestPasswordReset(email: string): Promise<void> {
  await request("/auth/password/forgot", acceptedSchema, { method: "POST", body: { email }, csrf: false });
}

export async function resetPassword(token: string, password: string): Promise<void> {
  await request("/auth/password/reset", passwordAuthSchema, { method: "POST", body: { token, password }, csrf: false });
}

export async function consumeMagicLink(token: string): Promise<string | null> {
  const result = await request("/auth/magic-links/consume", magicConsumeSchema, {
    method: "POST",
    body: { token },
    csrf: false,
  });
  return result.continueTo;
}

export async function logout(): Promise<void> {
  await request("/auth/logout", commandAcknowledgementSchema, {
    method: "POST",
    body: {},
  });
}

export async function setUsername(username: string): Promise<string> {
  return (
    await request("/me/username", usernameResponseSchema, {
      method: "POST",
      body: { username },
    })
  ).user.username;
}

export async function setPassword(password: string): Promise<void> {
  await request("/me/password", commandAcknowledgementSchema, { method: "POST", body: { password } });
}

export function getFriends(): Promise<FriendsResponse> {
  return request("/friends", friendsSchema);
}

export function searchFriend(username: string): Promise<FriendSearchResponse> {
  return request(
    `/friends/search?username=${encodeURIComponent(username)}`,
    friendSearchSchema,
  );
}

export async function sendFriendRequest(username: string): Promise<void> {
  await request("/friends/requests", commandAcknowledgementSchema, {
    method: "POST",
    body: { username },
  });
}

export async function respondToFriendRequest(
  requestId: string,
  response: "accept" | "decline",
): Promise<void> {
  await request(
    `/friends/requests/${encodeURIComponent(requestId)}/${response}`,
    commandAcknowledgementSchema,
    { method: "POST", body: {} },
  );
}

export async function removeFriend(friendUserId: string): Promise<void> {
  await request(`/friends/${encodeURIComponent(friendUserId)}`, commandAcknowledgementSchema, {
    method: "DELETE",
  });
}

export function createFriendInvitation(
  gameId: string,
  friendUserId: string,
): Promise<FriendInvitationCreated> {
  return request(
    `/games/${encodeURIComponent(gameId)}/friend-invitations`,
    friendInvitationCreatedSchema,
    { method: "POST", body: { friendUserId } },
  );
}

export async function getOutgoingFriendInvitation(
  gameId: string,
): Promise<{ readonly friend: FriendSummary | null; readonly status: "pending" | "accepted" | "declined" | null }> {
  return request(
    `/games/${encodeURIComponent(gameId)}/friend-invitation`,
    outgoingFriendInvitationSchema,
  );
}

export async function getFriendGameInvitations(): Promise<
  readonly FriendGameInvitation[]
> {
  return (await request("/friend-invitations", friendInvitationsSchema))
    .invitations;
}

export async function acceptFriendGameInvitation(
  invitationId: string,
): Promise<string> {
  return (
    await request(
      `/friend-invitations/${encodeURIComponent(invitationId)}/accept`,
      joinedFriendInvitationSchema,
      { method: "POST", body: {} },
    )
  ).gameId;
}

export async function declineFriendGameInvitation(
  invitationId: string,
): Promise<void> {
  await request(
    `/friend-invitations/${encodeURIComponent(invitationId)}/decline`,
    commandAcknowledgementSchema,
    { method: "POST", body: {} },
  );
}

export async function cancelWaitingRoom(gameId: string): Promise<void> {
  await request(
    `/games/${encodeURIComponent(gameId)}/waiting-room`,
    commandAcknowledgementSchema,
    { method: "DELETE" },
  );
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
  readonly method?: "GET" | "POST" | "DELETE";
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
  if (
    options.csrf !== false &&
    (options.method === "POST" || options.method === "DELETE")
  ) {
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
