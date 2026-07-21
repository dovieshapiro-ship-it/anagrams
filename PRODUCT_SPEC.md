# Anagrams Product Specification

## 1. Product summary

Anagrams is a persistent, server-authoritative, two-player word game intended to launch from an existing messaging conversation. One player creates a game and sends an invitation to another player. Both receive the same six-letter rack and complete private, independently timed 60-second rounds. Results are revealed only after both rounds are terminal.

The first release must be fully playable without access to the host company's APIs. A development lobby provides local identities, game creation, and copyable secure invitation links. The production integration remains provider-neutral and is connected later by implementing documented identity and messaging interfaces.

This is a deployable application, not a prototype: it includes persistent storage, authentication and authorization, secure invitations, concurrency-safe state transitions, tests, production builds, and deployment documentation.

## 2. Goals

- Allow two people on separate browsers or devices to complete a real game.
- Keep letters, time, word validity, score, and results authoritative on the server.
- Preserve game history and allow either player to initiate a rematch.
- Keep active submissions private from the opponent.
- Recover correctly after refresh, reconnect, or browser closure.
- Provide a polished mobile and embedded-webview experience.
- Offer a working development integration and a clean production messaging seam.
- Protect invitations and every game operation against forgery, replay, and cross-game access.
- Verify the product through unit, integration, and two-browser end-to-end tests.

## 3. Non-goals for the initial release

- Games with more than two players.
- Spectators, chat, tournaments, rankings, or public matchmaking.
- AI-based word validation or generated dictionaries.
- Simultaneous shared-round play; each player's timer starts independently.
- Offline gameplay or client-authoritative state.
- Localization beyond English.
- A company-specific messaging adapter before credentials and API details are supplied.
- Redis unless deployment requirements demonstrate a need for distributed rate limiting or coordination.

## 4. Users and modes

### 4.1 Development mode

A user enters a display name and receives a server-created development identity session. The user can create a game, copy its invitation URL, and share it manually. A second browser opens the URL, enters or confirms a distinct display name, and joins. Development identity is for local and preview environments and must be disabled or explicitly protected in production.

### 4.2 Messaging-platform mode

The host opens the game with a signed, short-lived launch token containing verified user and conversation context. The server verifies the token through `ChatIdentityProvider`, maps the stable external identity to a local user, and issues its own session. Invitation delivery and card creation use `ChatMessageProvider`. Browser-supplied user or conversation IDs are never trusted.

## 5. Core user journeys

### 5.1 Create and invite

1. Player A establishes an authenticated development or messaging session.
2. Player A creates a game.
3. The server generates the rack, stores the game and seat 1, and creates an expiring invitation.
4. The server returns a secure URL and provider-neutral game-card payload.
5. Development mode presents a copy action; production mode may send through the configured provider.
6. Player A sees a waiting screen and can safely refresh it.

### 5.2 Join

1. Player B opens the invitation URL.
2. The server validates the opaque token, expiry, intended recipient when present, and unused state.
3. Player B establishes a verified session.
4. The server transactionally consumes the invitation and assigns seat 2.
5. Both players proceed to the ready screen.

Invalid, expired, consumed, unauthorized, and already-full invitations show distinct safe user-facing states. A race between join attempts admits exactly one eligible second player.

### 5.3 Play

1. Each player marks ready.
2. A player starts their own round; the server records `startedAt` and `expiresAt`.
3. The UI displays the six-letter rack and a countdown derived from the server deadline.
4. Each submission is sent to the server and receives accepted or typed rejection feedback.
5. The player may finish early. Otherwise, the round expires at the server deadline.
6. During either active round, a player sees only their own accepted words and the opponent's coarse status.

The browser countdown is advisory. Reloading state always reconciles against server time, and the server rejects submissions at or after expiry.

### 5.4 Results

1. Once both rounds are finished or expired, the server finalizes the game exactly once.
2. The results screen displays both scores, each player's accepted words, each player's missed valid rack words, and winner or draw.
3. Completed results are immutable and remain available after refresh.

### 5.5 Rematch

1. Either player requests a rematch from a completed game.
2. The other player accepts the pending request.
3. The server creates exactly one new game linked to the previous game, with a new rack and the same two players.
4. Both players enter the new ready state. Prior results remain unchanged.

## 6. Game rules

Default rules are versioned and configurable in the game engine:

| Rule                | Default                                                            |
| ------------------- | ------------------------------------------------------------------ |
| Players             | Exactly two                                                        |
| Rack                | Six letters shared by both players                                 |
| Rack composition    | At least one vowel and one consonant                               |
| Round duration      | 60 seconds per player                                              |
| Minimum word length | 3 letters                                                          |
| Letter use          | No letter used more often than it appears in the rack              |
| Matching            | Case-insensitive after normalization                               |
| Duplicates          | Rejected per player/round                                          |
| Dictionary          | Configured redistributable English word list                       |
| Exclusions          | Proper nouns, abbreviations, punctuation, hyphenated words         |
| Score               | 3 letters: 100; 4 letters: 400; 5 letters: 1,200; 6 letters: 2,000 |

Highest score wins. Equal scores are resolved by greater accepted-word count; if both counts are equal, the result is a draw. Score values remain versioned and configurable so later game modes can use another table without changing validation or persistence code.

Normalization, rack feasibility, dictionary membership, duplicate detection, deadline checks, and scoring occur on the server. Dictionary source, version, and license must be documented and shipped reproducibly. AI models are not used for validation.

## 7. Functional requirements

### 7.1 Identity and authorization

- Every game operation requires an authenticated local session.
- The server derives player identity from the session, never request body data.
- A player can access only games in which they hold a seat.
- Development identities cannot silently impersonate production identities.
- Production launch tokens are signature-verified, short-lived, and replay-protected.

### 7.2 Invitations

- Identifiers and invitation secrets use a cryptographically secure generator.
- Invitation secrets are stored only as hashes, expire, and can be consumed once.
- Invitation creation is rate-limited and authorized to an existing game player.
- Consumption is transactional with seat assignment.
- A third player is always rejected.

### 7.3 State and timing

- Games, players, rounds, submissions, invitations, results, and rematches persist in PostgreSQL.
- Round start and expiration timestamps are generated by the server.
- Any active-round read or mutation first reconciles expiration.
- A periodic finalization sweep may improve timeliness, but correctness cannot depend on a connected browser or worker.
- Mutations are idempotent where retries are expected.
- Transactions, row locking, uniqueness constraints, and a game state version prevent races and stale transitions.

### 7.4 Word submission

- A submission is accepted only for the authenticated player's active, unexpired round.
- The server normalizes and validates the word against the stored rack and configured dictionary.
- Duplicate normalized words are rejected without adding score.
- Client-supplied score, rack, player, and timestamps are ignored or rejected.
- Submission responses include a stable typed outcome and current authoritative score.
- Submission endpoints are rate-limited without preventing ordinary rapid play.

### 7.5 Results and privacy

- Active state never contains the opponent's submitted words or score-derived details.
- Results are computed from accepted database submissions, not client totals.
- Finalization is idempotent and occurs only after both rounds are terminal.
- Completed state exposes both accepted lists, scores, missed valid rack words, and outcome.

## 8. Required screens and experience

- Development identity/lobby.
- Create game.
- Invitation waiting and copy/share state.
- Join confirmation.
- Invalid, expired, consumed, unauthorized, and full invitation states.
- Two-player ready state.
- Active rack, word input, synchronized countdown, accepted-word list, and validation feedback.
- Opponent status without active-word disclosure.
- Round-complete waiting state.
- Final results and rematch states.
- Connection loss, refresh recovery, and generic error recovery.

The interface must be responsive in a normal mobile browser and embedded webview, account for mobile safe areas, provide accessible labels and keyboard submission, use phone-appropriate touch targets, communicate state without color alone, and honor reduced-motion preferences. It should feel like a focused friendly word game rather than a generic dashboard.

## 9. Public API requirements

The versioned API is rooted at `/api/v1` and provides:

- Development-session creation.
- Game creation and invitation creation.
- Invitation inspection/join.
- Authenticated player game state.
- Ready, start round, submit word, and finish round operations.
- Final results.
- Rematch request and acceptance.
- Health, readiness, and generated OpenAPI endpoints.

All inputs and outputs use shared Zod contracts. Errors have a stable code, safe message, and request ID. Mutation retries use an idempotency key, and state-sensitive mutations carry an expected version where appropriate.

## 10. Security and operational requirements

- Secure HTTP headers and configurable CORS allowlist.
- HttpOnly, Secure-in-production, SameSite cookies protect local sessions.
- Database access uses Drizzle parameterization and explicit migrations.
- Secrets remain outside source control and logs are sanitized.
- Public errors are generic where disclosure would help an attacker; structured private logs include request IDs.
- Invitation and submission routes are rate-limited.
- Authorization is enforced in the service layer for every operation.
- Production startup never creates or mutates schema implicitly.
- Health reports process liveness; readiness verifies required dependencies.
- Production images run as non-root where practical and expose only required services.

## 11. Acceptance criteria

The release is acceptable only when all of the following have been run successfully:

- Two separate browser contexts create, join, play, finish, view results, and initiate a rematch.
- Refresh/reconnect restores authoritative state during every major phase.
- Invitation expiry, replay, unauthorized access, and third-player attempts are rejected.
- Concurrent join and submission tests preserve invariants.
- A deadline-bound submission is rejected after server expiry.
- Disconnected expired rounds finalize without client action.
- Unit tests cover all engine rules and state transitions.
- Integration tests cover the complete lifecycle and security boundaries.
- Lint, strict type checking, production builds, migrations, health, and readiness pass.
- Deployment and company-integration instructions reproduce the verified setup.

No capability is described as working in release documentation unless it was executed and verified.
