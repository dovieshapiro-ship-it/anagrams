import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface VerifiedChatUser {
  readonly provider: string;
  readonly externalUserId: string;
  readonly displayName: string;
  readonly conversationId?: string;
  readonly avatarUrl?: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface ChatIdentityProvider {
  verifyLaunchToken(token: string): Promise<VerifiedChatUser>;
}

export interface GameSummary {
  readonly gameId: string;
  readonly creatorDisplayName: string;
  readonly status: string;
  readonly invitationUrl: string;
  readonly expiresAt: string;
}

export interface GameCardPayload {
  readonly schemaVersion: string;
  readonly title: string;
  readonly body: string;
  readonly actionUrl: string;
  readonly fallbackUrl: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SendInvitationInput {
  readonly conversationId: string;
  readonly recipientExternalUserId?: string;
  readonly card: GameCardPayload;
  readonly idempotencyKey: string;
}

export interface ChatMessageProvider {
  createGameCard(game: GameSummary): Promise<GameCardPayload>;
  sendGameInvitation(input: SendInvitationInput): Promise<void>;
}

export type ProviderErrorCode =
  | "invalid_launch_token"
  | "expired_launch_token"
  | "replayed_launch_token"
  | "provider_not_configured"
  | "provider_unavailable"
  | "recipient_not_found"
  | "message_delivery_failed"
  | "idempotency_key_reused";

export class ProviderError extends Error {
  public constructor(public readonly code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface LaunchTokenReplayStore {
  /** Atomically consumes a nonce until expiry. Returns false when it was consumed already. */
  consume(nonce: string, expiresAt: Date): Promise<boolean>;
}

export class InMemoryLaunchTokenReplayStore implements LaunchTokenReplayStore {
  private readonly consumed = new Map<string, number>();

  public constructor(private readonly now: () => Date = () => new Date()) {}

  public consume(nonce: string, expiresAt: Date): Promise<boolean> {
    const now = this.now().getTime();
    for (const [key, expiry] of this.consumed) {
      if (expiry <= now) this.consumed.delete(key);
    }
    if (this.consumed.has(nonce)) return Promise.resolve(false);
    this.consumed.set(nonce, expiresAt.getTime());
    return Promise.resolve(true);
  }
}

export interface DevelopmentIdentityInput {
  readonly externalUserId: string;
  readonly displayName: string;
  readonly conversationId?: string;
  readonly avatarUrl?: string;
}

export interface DevelopmentIdentityProviderOptions {
  readonly secret: string | Uint8Array;
  readonly replayStore: LaunchTokenReplayStore;
  readonly issuer?: string;
  readonly audience?: string;
  readonly tokenLifetimeSeconds?: number;
  readonly now?: () => Date;
  readonly nonce?: () => string;
}

interface DevelopmentLaunchClaims {
  readonly iss: string;
  readonly aud: string;
  readonly sub: string;
  readonly name: string;
  readonly conversationId?: string;
  readonly avatarUrl?: string;
  readonly iat: number;
  readonly exp: number;
  readonly nonce: string;
}

export class DevelopmentChatIdentityProvider implements ChatIdentityProvider {
  private readonly secret: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly tokenLifetimeSeconds: number;
  private readonly now: () => Date;
  private readonly nonce: () => string;

  public constructor(private readonly options: DevelopmentIdentityProviderOptions) {
    this.secret = typeof options.secret === "string" ? Buffer.from(options.secret, "utf8") : options.secret;
    if (this.secret.byteLength < 32) throw new TypeError("Development launch-token secret must be at least 32 bytes");
    this.issuer = options.issuer ?? "anagrams-development";
    this.audience = options.audience ?? "anagrams-game";
    this.tokenLifetimeSeconds = options.tokenLifetimeSeconds ?? 300;
    if (!Number.isSafeInteger(this.tokenLifetimeSeconds) || this.tokenLifetimeSeconds <= 0 || this.tokenLifetimeSeconds > 900) {
      throw new RangeError("tokenLifetimeSeconds must be between 1 and 900");
    }
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? (() => randomBytes(24).toString("base64url"));
  }

  public issueLaunchToken(input: DevelopmentIdentityInput): string {
    const externalUserId = requiredText(input.externalUserId, "externalUserId", 255);
    const displayName = requiredText(input.displayName, "displayName", 80);
    const issuedAt = Math.floor(this.now().getTime() / 1_000);
    const claims: DevelopmentLaunchClaims = {
      iss: this.issuer,
      aud: this.audience,
      sub: externalUserId,
      name: displayName,
      iat: issuedAt,
      exp: issuedAt + this.tokenLifetimeSeconds,
      nonce: requiredText(this.nonce(), "nonce", 512),
      ...(input.conversationId === undefined ? {} : { conversationId: requiredText(input.conversationId, "conversationId", 255) }),
      ...(input.avatarUrl === undefined ? {} : { avatarUrl: validUrl(input.avatarUrl, "avatarUrl") }),
    };
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  public async verifyLaunchToken(token: string): Promise<VerifiedChatUser> {
    const segments = token.split(".");
    const payload = segments[0];
    const suppliedSignature = segments[1];
    if (segments.length !== 2 || payload === undefined || suppliedSignature === undefined) {
      throw invalidToken();
    }
    const expected = Buffer.from(this.sign(payload), "base64url");
    let supplied: Buffer;
    try {
      supplied = Buffer.from(suppliedSignature, "base64url");
    } catch {
      throw invalidToken();
    }
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw invalidToken();

    const claims = parseClaims(payload);
    if (claims.iss !== this.issuer || claims.aud !== this.audience) throw invalidToken();
    const nowSeconds = Math.floor(this.now().getTime() / 1_000);
    if (claims.iat > nowSeconds || claims.exp <= claims.iat || claims.exp - claims.iat > this.tokenLifetimeSeconds) throw invalidToken();
    if (nowSeconds >= claims.exp) throw new ProviderError("expired_launch_token", "Launch token has expired");
    const expiresAt = new Date(claims.exp * 1_000);
    if (!(await this.options.replayStore.consume(claims.nonce, expiresAt))) {
      throw new ProviderError("replayed_launch_token", "Launch token has already been used");
    }
    return {
      provider: "development",
      externalUserId: claims.sub,
      displayName: claims.name,
      issuedAt: new Date(claims.iat * 1_000),
      expiresAt,
      ...(claims.conversationId === undefined ? {} : { conversationId: claims.conversationId }),
      ...(claims.avatarUrl === undefined ? {} : { avatarUrl: claims.avatarUrl }),
    };
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
}

export interface DevelopmentDeliveryReceipt {
  readonly conversationId: string;
  readonly recipientExternalUserId?: string;
  readonly idempotencyKey: string;
  readonly sanitizedActionUrl: string;
  readonly sentAt: Date;
}

export class DevelopmentChatMessageProvider implements ChatMessageProvider {
  private readonly receiptsByKey = new Map<string, DevelopmentDeliveryReceipt>();

  public constructor(private readonly now: () => Date = () => new Date()) {}

  public createGameCard(game: GameSummary): Promise<GameCardPayload> {
    const creator = requiredText(game.creatorDisplayName, "creatorDisplayName", 80);
    const actionUrl = validUrl(game.invitationUrl, "invitationUrl");
    const expiresAt = new Date(game.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) throw new TypeError("expiresAt must be an ISO timestamp");
    return Promise.resolve({
      schemaVersion: "1",
      title: "Play Anagrams",
      body: `${creator} invited you to a game. Invitation expires ${expiresAt.toISOString()}.`,
      actionUrl,
      fallbackUrl: actionUrl,
      metadata: { kind: "anagrams-invitation" },
    });
  }

  public sendGameInvitation(input: SendInvitationInput): Promise<void> {
    const conversationId = requiredText(input.conversationId, "conversationId", 255);
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 255);
    const sanitizedActionUrl = sanitizeUrl(input.card.actionUrl);
    const existing = this.receiptsByKey.get(idempotencyKey);
    if (existing !== undefined) {
      if (
        existing.conversationId !== conversationId ||
        existing.recipientExternalUserId !== input.recipientExternalUserId ||
        existing.sanitizedActionUrl !== sanitizedActionUrl
      ) {
        return Promise.reject(
          new ProviderError(
            "idempotency_key_reused",
            "Idempotency key was reused for another invitation",
          ),
        );
      }
      return Promise.resolve();
    }
    this.receiptsByKey.set(idempotencyKey, {
      conversationId,
      idempotencyKey,
      sanitizedActionUrl,
      sentAt: this.now(),
      ...(input.recipientExternalUserId === undefined
        ? {}
        : { recipientExternalUserId: requiredText(input.recipientExternalUserId, "recipientExternalUserId", 255) }),
    });
    return Promise.resolve();
  }

  public deliveryReceipts(): readonly DevelopmentDeliveryReceipt[] {
    return [...this.receiptsByKey.values()];
  }
}

export class ProductionChatProviderPlaceholder implements ChatIdentityProvider, ChatMessageProvider {
  public verifyLaunchToken(token: string): Promise<VerifiedChatUser> {
    void token;
    return Promise.reject(notConfigured());
  }

  public createGameCard(game: GameSummary): Promise<GameCardPayload> {
    void game;
    return Promise.reject(notConfigured());
  }

  public sendGameInvitation(input: SendInvitationInput): Promise<void> {
    void input;
    return Promise.reject(notConfigured());
  }
}

function parseClaims(payload: string): DevelopmentLaunchClaims {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw invalidToken();
  }
  if (!isRecord(value)) throw invalidToken();
  const keys = Object.keys(value);
  const allowed = new Set(["iss", "aud", "sub", "name", "conversationId", "avatarUrl", "iat", "exp", "nonce"]);
  if (keys.some((key) => !allowed.has(key))) throw invalidToken();
  if (
    typeof value.iss !== "string" || typeof value.aud !== "string" ||
    typeof value.sub !== "string" || typeof value.name !== "string" ||
    typeof value.iat !== "number" || !Number.isSafeInteger(value.iat) ||
    typeof value.exp !== "number" || !Number.isSafeInteger(value.exp) ||
    typeof value.nonce !== "string" ||
    (value.conversationId !== undefined && typeof value.conversationId !== "string") ||
    (value.avatarUrl !== undefined && typeof value.avatarUrl !== "string")
  ) throw invalidToken();
  return {
    iss: requiredText(value.iss, "iss", 255), aud: requiredText(value.aud, "aud", 255),
    sub: requiredText(value.sub, "sub", 255), name: requiredText(value.name, "name", 80),
    iat: value.iat, exp: value.exp, nonce: requiredText(value.nonce, "nonce", 512),
    ...(value.conversationId === undefined ? {} : { conversationId: requiredText(value.conversationId, "conversationId", 255) }),
    ...(value.avatarUrl === undefined ? {} : { avatarUrl: validUrl(value.avatarUrl, "avatarUrl") }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: string, field: string, maximumLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) throw new TypeError(`${field} is invalid`);
  return normalized;
}

function validUrl(value: string, field: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError(`${field} must be an absolute URL`); }
  if (url.protocol !== "https:" && url.hostname !== "localhost") throw new TypeError(`${field} must use HTTPS`);
  return url.toString();
}

function sanitizeUrl(value: string): string {
  const url = new URL(validUrl(value, "actionUrl"));
  url.search = "";
  url.hash = "";
  return url.toString();
}

function invalidToken(): ProviderError {
  return new ProviderError("invalid_launch_token", "Launch token is invalid");
}

function notConfigured(): ProviderError {
  return new ProviderError("provider_not_configured", "Production chat provider is not configured");
}
