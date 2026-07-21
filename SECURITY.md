# Security and Threat Model

This document defines the security boundary for Anagrams. The API and PostgreSQL database are authoritative for identity, membership, letters, time, word validity, scoring, and game state. Browser state and browser timers are presentation aids only.

## Assets and trust boundaries

Assets requiring protection include:

- provider identities, development sessions, launch tokens, and invitation tokens;
- game membership and private in-progress submissions;
- racks, deadlines, accepted words, scores, and completed-game history;
- signing keys, database and Redis credentials, provider secrets, and operational logs;
- API and database availability.

Requests cross these trust boundaries:

1. An untrusted browser or embedded webview calls the web application and API.
2. A messaging provider signs a launch assertion that the API verifies; provider-supplied conversation context does not grant game access by itself.
3. The API reads and writes PostgreSQL. PostgreSQL is the durable source of truth.
4. The API may use Redis for distributed rate limiting. Redis is not authoritative for gameplay.
5. A background expiry worker executes the same transactional state transitions as request handlers.

The messaging host, reverse proxy, database, Redis, and deployment platform are trusted only for their documented roles. Forwarded headers are trusted only from explicitly configured proxies.

## Threat model

The expected adversary is an Internet client who may modify requests, enumerate identifiers, replay links, open concurrent connections, manipulate its clock, forge scores or player IDs, submit after a deadline, and attempt to view another player's words. Invitation URLs may be leaked through logs, browser history, screenshots, referrers, or forwarding. A legitimate player may also try to obtain the opponent's active submissions or exhaust API resources.

Primary threats and controls are:

| Threat                                            | Required control                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account or player impersonation                   | Verify signed provider assertions; use server-created development sessions; never accept a player identity from request data.                     |
| Game-ID enumeration or IDOR                       | Authorize every game operation by authenticated user membership; treat IDs only as locators.                                                      |
| Invitation guessing, replay, or double redemption | Generate at least 256 bits of randomness, store only a cryptographic hash, expire and revoke tokens, and redeem once inside a locked transaction. |
| Third-player join or concurrent seat claim        | Lock invitation and game rows; enforce unique game seat and game/user constraints in PostgreSQL.                                                  |
| Forged rack, time, validation, or score           | Ignore or reject client authority fields; generate and calculate all such values on the server.                                                   |
| Late submission or client clock manipulation      | Compare the database clock with the persisted deadline while holding the round lock.                                                              |
| Duplicate or concurrent submission                | Require an idempotency key and enforce database uniqueness for idempotency key and normalized accepted word.                                      |
| Premature result disclosure                       | Use player-specific response DTOs; never query or serialize opponent submissions until the game is completed.                                     |
| Cross-site request forgery                        | Prefer same-origin deployment; otherwise use an exact origin allowlist, credentialed CORS, Origin checks, and CSRF tokens for mutations.          |
| Injection and malformed payloads                  | Strict Zod schemas, bounded strings and bodies, Drizzle parameter binding, and no dynamic SQL from input.                                         |
| Credential or personal-data leakage               | Redact headers, cookies, raw tokens, connection strings, and request bodies from logs; return generic public errors.                              |
| Resource exhaustion                               | Per-route distributed rate limits, request-size limits, database timeouts, bounded dictionary work, and health/readiness separation.              |

Denial of service by a sufficiently capable network adversary and compromise of the hosting platform are outside the application's complete control. Platform-level DDoS protection, secret management, network isolation, backups, and monitoring remain required.

## Authentication and invitations

### Production provider

The production adapter must verify launch tokens server-side. Prefer asymmetric JWS with pinned issuer and audience. Verify signature, algorithm, issuer, audience, expiration, not-before time, and a nonce or `jti` where replay is relevant. Support provider key rotation without accepting arbitrary token-supplied key URLs. Map the verified provider and stable subject to `chat_identities`; do not trust browser-supplied user or conversation IDs.

Signing keys and provider credentials must come from the deployment secret store, never source control or client bundles. Launch tokens should be short-lived and exchanged for an application session rather than reused on every request.

### Development provider

Entering a display name creates a new server-side identity and session. A display name is a label, not a login credential, and must never select or recover an existing identity. Sessions use opaque, high-entropy tokens stored as hashes, or an equivalently well-reviewed session mechanism. Session cookies are `HttpOnly`, `Secure` in production, narrowly scoped, and `SameSite=Lax` unless the embedding contract requires another mode. Sessions expire, can be revoked, and rotate after invitation redemption or other privilege changes.

### Invitation lifecycle

- Generate invitation secrets with a cryptographically secure random generator using at least 32 random bytes.
- Put the raw token only in the invitation URL and store a SHA-256 or keyed hash in PostgreSQL.
- Give invitations a short, documented expiration and allow revocation.
- Bind a production invitation to the intended verified provider identity when that identity is available.
- Redeem by hashing the presented token, locking invitation and game rows, checking expiry/revocation/use with database time, claiming the vacant seat, and marking the invitation used in one transaction.
- Return the same generic public response for unknown and unusable tokens where enumeration is a concern.
- After successful redemption, redirect to a clean game URL so the token is removed from the address bar. The invitation page sends `Referrer-Policy: no-referrer` and must not load third-party resources.
- Never log raw invitation or launch tokens. Monitoring and rate-limit keys may use a non-reversible token digest.

Forwarding a development invitation intentionally transfers the capability to claim the open seat. Once claimed, possession of the old link grants no continuing access.

## Authorization and data privacy

Every protected handler derives the user from the verified application session, loads membership server-side, and checks that the requested action is valid for that membership and current state. Clients cannot choose `userId`, `playerId`, seat, rack, score, timestamps, or game ownership. Administrative and worker paths use separate credentials and are not exposed through public routing.

State responses must be explicit DTOs rather than serialized database records. While either round is active, a player may see the opponent's public status but not the opponent's submitted words, rejected attempts, score progression, or word count if that count would leak strategy. Final-result DTOs become available only after committed finalization. Authenticated game responses use `Cache-Control: no-store`; shared caches must not store them.

Completed history remains membership-protected. Database backups, analytics, and support tools are subject to the same confidentiality requirements.

## Concurrency, timers, and finalization

PostgreSQL constraints and transactions enforce correctness. The standard lock order is game, players in seat order, then rounds in seat order. Transactions remain short, and retryable serialization or deadlock failures receive a small bounded retry with jitter.

- Joining locks the invitation and game, then atomically claims seat two and consumes the invitation. Unique `(game_id, seat)` and `(game_id, user_id)` constraints are the final defense against races.
- State-changing requests carry an expected state version where stale decisions matter. Updates increment the version or return a typed `409 STALE_STATE` response.
- Starting a round stores `started_at` and `expires_at` from server/database time in one transaction.
- Submitting locks the round, evaluates the hard deadline with a consistent database clock, validates against the persisted rack and configured dictionary, inserts the idempotent submission, and updates derived totals atomically. The boundary is explicit: a submission is accepted only when receipt time is strictly before `expires_at`.
- Finishing and expiry use the same idempotent transition. Reads and mutations reconcile overdue rounds, while a periodic worker selects due rounds with `FOR UPDATE SKIP LOCKED` so disconnected clients finish.
- Finalization locks the game and both rounds, requires both rounds to be terminal, recomputes totals from accepted submissions, applies tie-breaking, persists results, and marks the game completed in one transaction. Repeated finalization is a no-op.
- Rematch acceptance locks the source game/request and creates at most one resulting game.

Redis may coordinate rate limits, but Redis outages or duplicated workers must not corrupt game state, extend deadlines, or produce duplicate results.

## Validation, errors, and logging

All request path, query, header, and body inputs use strict schemas that reject unknown authority-bearing fields. Apply conservative limits to display names, words, identifiers, headers, and JSON bodies. Word normalization occurs once in the game engine; validate allowed characters, minimum length, rack multiplicity, dictionary membership, and duplicate status in that order without trusting client feedback.

Use parameterized Drizzle queries. Any necessary raw SQL uses fixed statements with bound values. Never interpolate identifiers or sort expressions from unvalidated input. Render user-visible strings through React text interpolation rather than raw HTML.

Public errors use a stable typed shape containing a safe code, safe message, and request correlation ID. Authentication and invitation failures do not reveal sensitive existence details. Detailed exceptions remain in private structured logs. Logs redact at minimum:

- `Authorization`, `Cookie`, and `Set-Cookie` headers;
- launch, session, CSRF, invitation, and provider tokens, including query strings containing them;
- database/Redis URLs, secrets, and signing material;
- request bodies containing words or identity assertions unless a documented operational need justifies a sanitized field.

Log authorization failures, rate-limit events, invitation lifecycle events by record ID (not raw token), state-transition conflicts, worker failures, and unexpected finalization outcomes. Protect logs with access controls and retention limits.

## HTTP headers, CORS, and CSRF

Use secure headers through a maintained Fastify plugin and verify the emitted policy. At minimum configure:

- Content Security Policy restricted to application assets and required provider origins; no `unsafe-eval` in production;
- `frame-ancestors` limited to the documented messaging host domains, or `'none'` outside embedded deployments;
- HSTS in HTTPS production, `X-Content-Type-Options: nosniff`, and a restrictive `Permissions-Policy`;
- `Referrer-Policy: no-referrer` for invitation routes and at least `strict-origin-when-cross-origin` elsewhere;
- `Cache-Control: no-store` on authenticated and token-bearing responses.

TLS terminates only at an approved proxy or application endpoint. Production redirects cleartext HTTP to HTTPS.

CORS reads an explicit environment allowlist. Never reflect arbitrary origins and never combine credentialed requests with `*`. Permit only required methods and headers. Reject mutating requests whose `Origin` is absent or not allowed, with a carefully documented exception for non-browser provider callbacks that authenticate independently.

When cookies authenticate mutations, use a cryptographically random CSRF token bound to the session and verified using the header/body token pattern. `SameSite` is defense in depth, not the sole CSRF control, especially in embedded webviews. Provider webhooks instead require provider signature verification, timestamp tolerance, and replay protection.

## Rate limiting and abuse handling

Production deployments with more than one API instance use a shared Redis-backed limiter. Development and isolated tests may use an in-memory store. Suggested initial limits, to be tuned from metrics, are:

| Operation           | Initial policy                                           |
| ------------------- | -------------------------------------------------------- |
| Create invitation   | 5 per minute and 20 per hour per authenticated user      |
| Redeem invitation   | 10 per minute per IP, plus throttling by token digest    |
| Submit word         | burst of 30 per 10 seconds and 120 per minute per player |
| Create game/session | 10 per hour per user or IP fallback                      |
| Read state/results  | 120 per minute per session                               |

Keys combine route and authenticated user/player; unauthenticated routes use a normalized client IP and an additional target digest where applicable. Configure trusted proxies explicitly before consuming forwarding headers. Send `429` and `Retry-After`, and do not let rate-limit counters replace authorization or database constraints. Define Redis failure behavior per route: game reads may fail open with local protection, while invitation creation/redemption should use conservative fallback limits.

Additional abuse controls include maximum active games and invitations per user, bounded invitation lifetime, expired-record cleanup, request and database timeouts, connection-pool limits, and bounded result generation. Repeated token failures and suspicious cross-game access should produce security telemetry without exposing detection details to the requester.

## Operational security

- Commit `.env.example` with names and safe descriptions only. Load real secrets through the production secret manager and rotate them after suspected disclosure.
- Use separate least-privilege database roles for migrations and runtime. The runtime role must not create or alter schema.
- Restrict PostgreSQL and Redis to private networks, require authentication and transport encryption as supported, and do not publish them directly to the Internet.
- Run containers as non-root with minimal images, read-only filesystems where practical, resource limits, and current patched dependencies.
- Generate and review explicit migrations; never create production schema silently at startup. Back up PostgreSQL, encrypt backups, test restoration, and define retention/deletion policy.
- Separate liveness from readiness. Readiness verifies required dependencies without returning versions, credentials, or internal topology.
- Monitor elevated authentication failures, invitation redemption failures, `429` rates, database lock/deadlock errors, overdue rounds, finalization lag, and worker failure. Alert on sustained anomalies.
- Pin and document the dictionary artifact and license. Verify its checksum during builds; do not fetch mutable dictionaries at runtime.
- Keep production debugging endpoints disabled. Source maps and detailed stack traces must not be public.

## Abuse cases to test

The security test suite must include:

- changing game, player, round, invitation, or submission IDs to access another user's data;
- supplying a forged player ID, seat, rack, score, start time, expiry, or accepted flag;
- redeeming an expired, revoked, malformed, already-used, or concurrently used invitation;
- two invitations concurrently claiming the last seat and a third user attempting to join;
- submitting the same word with different casing, repeated idempotency keys, concurrent requests, excess rack letters, punctuation, overlong input, and invalid Unicode;
- submitting immediately before, at, and after the server deadline, including concurrently with finish/expiry;
- starting, finishing, finalizing, and accepting a rematch twice or from a stale state version;
- reading active state as the opponent and checking all response fields, caches, logs, and error bodies for leaked words;
- cross-origin credentialed mutations, invalid CSRF tokens, disallowed origins, spoofed forwarding headers, and invalid provider signatures;
- bursts against invitation and submission endpoints from one user and multiple sessions;
- worker duplication, browser disconnect, API restart, Redis outage, and delayed expiry processing without correctness loss.

## Release verification checklist

- [ ] Secrets, tokens, cookies, request bodies, and database URLs are absent from source, client bundles, logs, traces, and error responses.
- [ ] Provider verification checks signature, allowed algorithm, issuer, audience, time claims, and replay controls.
- [ ] Development identities are server-session based; display names cannot impersonate another player.
- [ ] Every protected route has a membership and action-level authorization test.
- [ ] Invitation tokens have sufficient entropy, are stored only as hashes, expire, revoke, redeem atomically, and disappear from the URL after use.
- [ ] Database uniqueness constraints and concurrent integration tests prove exactly two seats and idempotent submissions/finalization/rematches.
- [ ] Deadlines use server/database time and expired disconnected rounds finalize through the worker.
- [ ] Opponent words cannot appear before completed finalization in APIs, HTML, caches, logs, telemetry, or websocket/event payloads.
- [ ] Strict input schemas, request-size limits, parameterized queries, safe rendering, and generic public errors are enabled.
- [ ] CSP, frame restrictions, HSTS, no-sniff, permissions, referrer, and no-store policies are verified against the production build.
- [ ] CORS is an exact allowlist and all cookie-authenticated mutations enforce Origin and CSRF checks.
- [ ] Shared production rate limiting, proxy trust, fallback behavior, and `Retry-After` responses are tested.
- [ ] Runtime and migration database roles are separate; PostgreSQL and Redis are not publicly exposed.
- [ ] Dependency, container, and secret scans pass; dictionary origin, license, version, and checksum are documented.
- [ ] Encrypted backup restoration, key rotation, monitoring, alerting, health/readiness, and incident procedures are exercised before launch.
