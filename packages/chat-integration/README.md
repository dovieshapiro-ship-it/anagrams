# `@anagrams/chat-integration`

Provider-neutral identity and invitation-card contracts for launching Anagrams from a messaging host.

## Development provider

`DevelopmentChatIdentityProvider` issues and verifies HMAC-SHA-256 launch tokens with issuer, audience, issued-at, expiry, and nonce claims. Verification is fail-closed and consumes the nonce through an injected `LaunchTokenReplayStore`. `InMemoryLaunchTokenReplayStore` is suitable only for a single-process development server; production or multi-replica deployments need a transactional database/Redis implementation.

`DevelopmentChatMessageProvider` builds a compact copyable game card and records sanitized delivery receipts for local inspection. It never retains token-bearing query strings. Sending the same idempotency key again is a no-op; reusing it for different delivery metadata fails.

The game server remains responsible for its HttpOnly session, mapping verified external identities to local users, persisting invitations, seat assignment, and all authorization.

## Production placeholder

`ProductionChatProviderPlaceholder` implements both interfaces and always throws `ProviderError("provider_not_configured")`. It has no development fallback. Replace it only after the host company supplies the verification, identity, conversation, card, deep-link, callback, CORS, and webview details in `INTEGRATION_GUIDE.md`.

Raw launch and invitation tokens must never be logged or stored by provider adapters.
