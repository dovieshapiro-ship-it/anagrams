import { describe, expect, it } from "vitest";

import {
  DevelopmentChatIdentityProvider,
  DevelopmentChatMessageProvider,
  InMemoryLaunchTokenReplayStore,
  ProductionChatProviderPlaceholder,
  ProviderError,
} from "./index.js";

const secret = "a-development-secret-with-at-least-32-bytes";

describe("development identity provider", () => {
  it("issues, verifies, and normalizes a short-lived signed identity", async () => {
    const now = () => new Date("2026-07-21T12:00:00.000Z");
    const provider = new DevelopmentChatIdentityProvider({
      secret,
      replayStore: new InMemoryLaunchTokenReplayStore(now),
      now,
      nonce: () => "unique-nonce",
    });
    const token = provider.issueLaunchToken({
      externalUserId: "user-1",
      displayName: " Ada ",
      conversationId: "conversation-1",
      avatarUrl: "https://example.test/ada.png",
    });
    await expect(provider.verifyLaunchToken(token)).resolves.toMatchObject({
      provider: "development",
      externalUserId: "user-1",
      displayName: "Ada",
      conversationId: "conversation-1",
    });
  });

  it("rejects tampering, expiry, replay, and weak secrets", async () => {
    let current = new Date("2026-07-21T12:00:00.000Z");
    const now = () => current;
    const provider = new DevelopmentChatIdentityProvider({
      secret,
      replayStore: new InMemoryLaunchTokenReplayStore(now),
      now,
      nonce: () => "one-time-nonce",
      tokenLifetimeSeconds: 60,
    });
    const token = provider.issueLaunchToken({ externalUserId: "user-1", displayName: "Ada" });
    await expect(provider.verifyLaunchToken(`${token.slice(0, -1)}x`)).rejects.toMatchObject({ code: "invalid_launch_token" });
    await provider.verifyLaunchToken(token);
    await expect(provider.verifyLaunchToken(token)).rejects.toMatchObject({ code: "replayed_launch_token" });

    const expiring = new DevelopmentChatIdentityProvider({
      secret,
      replayStore: new InMemoryLaunchTokenReplayStore(now),
      now,
      nonce: () => "expiry-nonce",
      tokenLifetimeSeconds: 60,
    });
    const expiredToken = expiring.issueLaunchToken({ externalUserId: "user-2", displayName: "Grace" });
    current = new Date("2026-07-21T12:01:00.000Z");
    await expect(expiring.verifyLaunchToken(expiredToken)).rejects.toMatchObject({ code: "expired_launch_token" });
    expect(() => new DevelopmentChatIdentityProvider({ secret: "too-short", replayStore: new InMemoryLaunchTokenReplayStore() })).toThrow(TypeError);
  });
});

describe("development message provider", () => {
  it("builds a compact card and records only sanitized idempotent delivery metadata", async () => {
    const provider = new DevelopmentChatMessageProvider(() => new Date("2026-07-21T12:00:00.000Z"));
    const card = await provider.createGameCard({
      gameId: "game-1",
      creatorDisplayName: "Ada",
      status: "waiting_for_opponent",
      invitationUrl: "https://game.example/join?token=top-secret#fragment",
      expiresAt: "2026-07-21T12:15:00.000Z",
    });
    const input = { conversationId: "conversation-1", card, idempotencyKey: "delivery-1" };
    await provider.sendGameInvitation(input);
    await provider.sendGameInvitation(input);
    expect(provider.deliveryReceipts()).toEqual([
      {
        conversationId: "conversation-1",
        idempotencyKey: "delivery-1",
        sanitizedActionUrl: "https://game.example/join",
        sentAt: new Date("2026-07-21T12:00:00.000Z"),
      },
    ]);
    expect(JSON.stringify(provider.deliveryReceipts())).not.toContain("top-secret");
  });

  it("rejects conflicting reuse of a delivery key", async () => {
    const provider = new DevelopmentChatMessageProvider();
    const card = await provider.createGameCard({
      gameId: "game-1", creatorDisplayName: "Ada", status: "waiting",
      invitationUrl: "https://game.example/join?token=secret", expiresAt: "2026-07-21T12:15:00.000Z",
    });
    await provider.sendGameInvitation({ conversationId: "one", card, idempotencyKey: "same" });
    await expect(provider.sendGameInvitation({ conversationId: "two", card, idempotencyKey: "same" })).rejects.toMatchObject({ code: "idempotency_key_reused" });
  });
});

describe("production placeholder", () => {
  it("fails closed for identity, card creation, and delivery", async () => {
    const provider = new ProductionChatProviderPlaceholder();
    await expect(provider.verifyLaunchToken("anything")).rejects.toEqual(expect.objectContaining({ code: "provider_not_configured" }));
    await expect(provider.createGameCard({
      gameId: "game", creatorDisplayName: "Ada", status: "waiting",
      invitationUrl: "https://example.test/join", expiresAt: "2026-07-21T12:15:00.000Z",
    })).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.sendGameInvitation({
      conversationId: "conversation", idempotencyKey: "key",
      card: { schemaVersion: "1", title: "x", body: "x", actionUrl: "https://example.test", fallbackUrl: "https://example.test", metadata: {} },
    })).rejects.toMatchObject({ code: "provider_not_configured" });
  });
});
