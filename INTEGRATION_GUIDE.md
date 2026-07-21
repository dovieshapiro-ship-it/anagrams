# Messaging Platform Integration Guide

This document defines the boundary between Anagrams and a host messaging platform. The game is fully playable without a company integration through the development provider. The production adapter remains deliberately provider-neutral until the messaging company supplies the information listed below.

## Integration boundary

The messaging platform is responsible for authenticating its users, selecting a conversation and opponent, displaying or sending a game card, and opening the game deep link or embedded webview. Anagrams is responsible for verifying the platform assertion, creating its own short-lived launch context and authenticated session, authorizing every game operation, issuing invitations, and enforcing all game rules.

Browser-supplied user IDs, display names, conversation IDs, player seats, letters, scores, and timestamps are never authoritative. Stable platform identifiers enter the trusted system only through a server-verified launch token or a verified callback.

The provider-neutral package exposes contracts similar to:

```ts
export interface VerifiedChatUser {
  provider: string;
  externalUserId: string;
  displayName: string;
  conversationId?: string;
  avatarUrl?: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface ChatIdentityProvider {
  verifyLaunchToken(token: string): Promise<VerifiedChatUser>;
}

export interface GameSummary {
  gameId: string;
  creatorDisplayName: string;
  status: string;
  invitationUrl: string;
  expiresAt: string;
}

export interface GameCardPayload {
  schemaVersion: string;
  title: string;
  body: string;
  actionUrl: string;
  fallbackUrl: string;
  metadata: Record<string, string>;
}

export interface SendInvitationInput {
  conversationId: string;
  recipientExternalUserId?: string;
  card: GameCardPayload;
  idempotencyKey: string;
}

export interface ChatMessageProvider {
  createGameCard(game: GameSummary): Promise<GameCardPayload>;
  sendGameInvitation(input: SendInvitationInput): Promise<void>;
}
```

Provider implementations may add internal types, but the game service depends only on these contracts. Provider errors must be mapped to stable internal categories such as `invalid_launch_token`, `provider_unavailable`, `recipient_not_found`, and `message_delivery_failed`; raw upstream responses and secrets must not reach the browser or logs.

## Fully working development provider

The development provider is the default local integration and requires no external messaging credentials.

1. A user enters a display name in the development lobby.
2. The server creates a development identity for the current browser session and establishes an Anagrams session in a Secure, HttpOnly, SameSite cookie (Secure may be disabled only for local HTTP development). A display name is only a label and never resolves or recovers another identity.
3. The user creates a game. The server persists the game, creator seat, and an expiring, single-use invitation.
4. The waiting screen displays a copyable invitation URL and a compact JSON game-card preview.
5. A second user opens the URL in a separate browser or private context, enters a different display name, and joins.
6. The invitation is consumed transactionally when the second seat is assigned. Replay, expiry, game-full, and identity-conflict states receive explicit public errors.

Development identity is intentionally isolated from production identity. It must be enabled only by configuration, be clearly labeled in the UI, and be disabled in production deployments. Development invitation tokens receive the same entropy, expiry, hashing/signing, transactional consumption, rate limiting, and authorization protections as production invitations.

The development message provider does not claim to deliver an external message. `sendGameInvitation` records or logs sanitized delivery metadata and returns the URL/card for manual sharing. It must never log an invitation token.

## Production adapter placeholders

The production adapter supplies two concrete implementations:

- `ProductionChatIdentityProvider.verifyLaunchToken`: validates a company-issued assertion using the agreed signature or token introspection mechanism, checks all required claims, then returns a normalized identity.
- `ProductionChatMessageProvider.createGameCard`: converts `GameSummary` to the company's versioned card schema.
- `ProductionChatMessageProvider.sendGameInvitation`: invokes the company's message API with an idempotency key and maps the result to a delivery record.

Placeholder methods must fail closed with `provider_not_configured`; they must not accept unverified browser identity as a fallback. Production readiness requires contract fixtures, sandbox credentials, signature verification tests, delivery tests, and company approval of the card/deep-link behavior.

Configuration should select exactly one provider mode at startup. A production process must refuse to boot if development authentication is enabled or required production verification settings are absent.

## Information required from the messaging company

Before implementing the production adapter, obtain exact answers and sandbox examples for all of the following.

### Authentication and identity

- Launch-token format: JWT/JWS, opaque token, signed query payload, or another envelope.
- Token transport: authorization header, POST body, webview bridge, or launch URL parameter.
- Signature algorithm, issuer, audience, key IDs, and key rotation behavior.
- Public-key/JWKS URL or token-introspection endpoint, authentication method, timeout, and caching rules.
- Required claims, clock-skew allowance, maximum token lifetime, nonce or `jti` semantics, and replay guarantees.
- Stable, non-reassignable user identifier and whether it is global, tenant-scoped, or conversation-scoped.
- Trusted display-name and avatar fields, plus update and privacy rules.
- Tenant/workspace identifier where applicable.
- Whether bots, guests, minors, deactivated users, or external tenants are allowed.

### Conversation and recipient selection

- Stable conversation identifier and conversation type (direct, group, channel, or thread).
- How Player A selects Player B and which verified recipient identifier is returned.
- Authorization signal proving the launcher may send to that conversation/recipient.
- Whether the company, Anagrams, or the user performs the final send action.
- Group-chat behavior and whether a game card is visible to non-participants.

### Cards, messages, and delivery API

- Versioned message-card schema, limits, required accessibility text, supported buttons, images, and localization fields.
- API endpoint, OAuth scopes, service-account model, rate limits, retry guidance, and idempotency support.
- Delivery response format and stable message identifier.
- Update/replace/delete capabilities for reflecting joined, active, completed, or expired state.
- Link-preview behavior and rules preventing invitation tokens from appearing in unfurl logs.
- Sandbox credentials, test users/conversations, and representative request/response fixtures.

### Deep links and embedded webviews

- HTTPS/deep-link formats and whether universal/app links are required.
- Whether links open an external browser, in-app browser, or embedded webview.
- Webview user-agent behavior, cookie persistence, third-party-cookie restrictions, popup restrictions, and navigation allowlists.
- Whether launch context is delivered once or on every open.
- Back/close controls, refresh behavior, external-link behavior, and postMessage/native bridge contracts.
- Clipboard and share-sheet availability.
- Minimum viewport sizes, orientation support, keyboard resizing behavior, and supported OS/app versions.

### Network, domains, and browser policy

- Approved production, staging, and local-development origins.
- Redirect URI and deep-link allowlists.
- Exact CORS origins, permitted methods/headers, credential support, and preflight expectations.
- Content Security Policy requirements, framing policy (`frame-ancestors`), and required resource domains.
- DNS/domain ownership verification steps and certificate requirements.
- Proxy/IP allowlists, outbound webhook/message API destinations, and regional data-routing requirements.

### Callbacks and webhooks

- Required events, such as message delivery failure, card action, app uninstall, conversation deletion, user deactivation, or message deletion.
- Webhook endpoint registration and challenge/handshake flow.
- Signature scheme, timestamp tolerance, replay identifier, key rotation, retry schedule, ordering guarantees, and duplicate-delivery behavior.
- Expected acknowledgement timeout and supported status codes.
- Retention requirements and whether callbacks may contain personal data.

### Mobile safe areas

- Whether the host injects CSS `env(safe-area-inset-*)` values correctly.
- Any additional top/bottom inset communicated through CSS variables or a bridge.
- Reserved header/footer heights, dynamic toolbar behavior, and close-button overlap zones.
- Whether viewport-fit must be set to `cover`.
- Dark-mode, text-scaling, reduced-motion, and high-contrast behavior expected inside the host.

## Launch-token verification

The preferred flow uses a signed, short-lived, single-use company launch token. Verification occurs only on the server:

1. Accept the token through the agreed transport. If it appeared in a URL, exchange it immediately and replace the URL so it is removed from history, analytics, referrers, and screenshots.
2. Parse using an explicit algorithm allowlist; never trust an algorithm named by the token without policy enforcement.
3. Resolve the verification key by trusted issuer/key ID, with bounded JWKS caching and key-rotation support.
4. Verify signature, issuer, audience, `iat`, `nbf`, expiry, tenant, and any required conversation/recipient claims.
5. Atomically consume a nonce or `jti` until at least token expiry. A used assertion cannot create another session.
6. Normalize the trusted claims into `VerifiedChatUser`; reject missing or ambiguous stable identifiers.
7. Create or update the internal user/chat-identity mapping and establish an Anagrams session.

Opaque tokens must be checked through authenticated server-to-server introspection. Browser-side decoding is never verification. Raw launch tokens must not be stored in plaintext, placed in client storage, included in telemetry, or logged. Log only a correlation ID and a non-reversible token fingerprint when necessary.

If Anagrams issues an intermediate launch token, it must be cryptographically signed with a dedicated secret/key, be audience-bound, expire within minutes, include a nonce, and carry only the minimum identity and conversation context. It is exchanged once for the normal session cookie.

## Identity and session flow

```text
Host authenticates user
  -> host supplies signed launch assertion
  -> Anagrams server verifies assertion and replay state
  -> server maps (provider, tenant, external user ID) to internal user
  -> server creates a rotating authenticated session cookie
  -> all game API calls authorize the session and game seat
```

The invitation token grants permission to attempt joining; it is not a lasting player session. The join transaction binds the authenticated internal user to the available seat and consumes the invitation. Subsequent requests use the session plus server-side seat membership. Changing a game ID, player ID, or external user ID in the browser cannot change authorization.

Session cookies should use `HttpOnly`, `Secure`, a restrictive `SameSite` value compatible with the verified host launch flow, a narrow path/domain, and server-side revocation/expiry. Rotate the session after authentication and privilege-changing events. Do not use localStorage for credentials.

## Invitations, cards, deep links, and webviews

Invitation URLs contain a cryptographically random opaque token or signed token with sufficient entropy and short expiry. Prefer storing only a token hash. Consumption and seat assignment occur in one database transaction; exactly one second player can win concurrent joins. Error responses distinguish user-actionable states without leaking game or identity details.

The compact card should communicate the game name, inviter display name, call to action, expiry, accessible fallback text, and a single HTTPS action URL. It must not contain letters, player session credentials, internal database identifiers, scores, or other private game data. Card metadata should include only opaque correlation identifiers required for delivery or update.

Deep links should land on the invitation route, complete host authentication if necessary, exchange/remove launch credentials, and then show a join confirmation. Preserve invitation context across the authentication redirect using signed server state, not an editable browser user ID.

The web UI supports a normal mobile browser and embedded webview. It must tolerate refresh and process termination by recovering authoritative state from the server, use safe-area padding, maintain 44-by-44-pixel minimum touch targets, avoid popup-only flows, respect reduced motion and text scaling, and never rely on a browser timer for round authority.

## CORS, domains, and security headers

Use an explicit environment-provided origin allowlist; wildcard origins are forbidden with credentialed requests. Prefer same-origin web/API deployment. If origins differ, allow only required methods and headers, return a specific matching origin, set `Vary: Origin`, and allow credentials only when needed. Reject unknown `Origin` values on state-changing requests.

Maintain separate origin and redirect allowlists for development, staging, and production. Production secrets and company sandbox credentials must not be accepted by local development hosts. Apply a restrictive CSP, `frame-ancestors` limited to the approved host where embedding is required, HSTS in production, MIME sniffing protection, a safe referrer policy, and frame protections compatible with the documented embed mode.

## Callback and webhook processing

Expose callbacks only when the company requires them. Each callback handler must verify the raw-body signature and timestamp before parsing or acting, reject stale events, enforce body limits, and atomically record a provider event ID for idempotency. Acknowledge verified duplicates without repeating side effects. Process slow work asynchronously when the provider has a short acknowledgement deadline.

Callbacks can update delivery metadata or revoke integration access, but they cannot forge game results or bypass the game state machine. Sanitized structured logs should correlate provider event ID, internal delivery ID, and request ID. Failed processing should follow the company's documented retry/dead-letter policy.

## Integration testing

The provider-neutral contract test suite must run against both the development provider and the production adapter fixture implementation. It should cover:

- Valid launch assertion normalization and session creation.
- Bad signature, issuer, audience, expiry, not-before time, missing identity, wrong tenant, and replay.
- JWKS/key rotation or opaque-token introspection failures and timeouts.
- Stable mapping of the same external identity and isolation across providers/tenants.
- Invitation creation, expiry, replay, simultaneous join, wrong authenticated identity, and third-player rejection.
- Card schema snapshots validated against company fixtures.
- Send success, timeout, retry, duplicate idempotency key, rate limit, permanent failure, and sanitized logging.
- Deep-link launch in an external browser and the supported embedded webview.
- Cookie persistence, refresh recovery, blocked-popup conditions, safe-area layout, mobile keyboard resize, dark mode, reduced motion, and large text.
- CORS allowlist/denial, CSP framing from the approved host, and rejection of unapproved origins.
- Valid, invalid, stale, replayed, duplicated, and out-of-order webhooks.

End-to-end certification should use two real company sandbox identities in separate browser contexts/devices: Player A launches from a conversation and sends the card; Player B opens it and joins; both complete a game; neither sees the other's active submissions; both see the same result; and a rematch succeeds. Retain request IDs, sanitized server logs, screenshots, and provider delivery IDs as test evidence, never tokens.

## Rollout checklist

- [ ] Company answers every information request above and supplies current documentation, contacts, sandbox credentials, and fixtures.
- [ ] Production identity and message adapters pass the shared contract tests.
- [ ] Signature/introspection verification, key rotation, replay protection, and fail-closed startup are exercised.
- [ ] External IDs are correctly scoped by provider and tenant; account deletion/deactivation behavior is agreed.
- [ ] Card content, accessibility text, localization, invitation expiry, and update behavior are approved.
- [ ] Production/staging domains, redirects, CORS, CSP framing, DNS, certificates, and outbound endpoints are allowlisted.
- [ ] Webhook verification, idempotency, retries, monitoring, and incident ownership are tested.
- [ ] Real webview tests pass on the minimum supported iOS, Android, desktop, and app versions, including safe areas and large text.
- [ ] Two-user sandbox E2E play, refresh recovery, simultaneous join, invitation replay, and rematch pass.
- [ ] Rate limits, timeouts, retries, circuit breaking, and delivery-failure UX are agreed and load tested.
- [ ] Logs, analytics, traces, referrers, and error reports have been checked for token or personal-data leakage.
- [ ] Privacy, retention, regional hosting, consent, deletion, support, and security-review requirements are signed off.
- [ ] Development authentication is disabled and production configuration is validated at startup.
- [ ] A staged rollout, rollback plan, status dashboard, alert routing, and company escalation contact are documented.

Until this checklist is complete, deployments should use the fully working development provider or a company sandbox only. The unimplemented production adapter must fail closed and must never silently fall back to development identity.
