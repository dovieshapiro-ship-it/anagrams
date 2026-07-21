# Anagrams Architecture

## 1. Architectural principles

- **Server authority:** PostgreSQL-backed server services decide identity, rack, time, validity, score, transitions, and results.
- **Pure domain core:** game rules are framework-independent and deterministic under injected clock and random sources.
- **Contract first:** shared Zod schemas define the boundary between web, server, tests, and OpenAPI.
- **Explicit privacy projections:** active and completed game responses are different shapes; database rows are never serialized directly.
- **Transactional transitions:** state changes are atomic, idempotent where retried, and protected by constraints plus locking/version checks.
- **Replaceable messaging provider:** host-company details enter only through provider interfaces.
- **Persisted-time correctness:** expiration is derived from stored server timestamps and does not require a browser timer or Redis scheduler.

## 2. Monorepo layout

```text
anagrams/
├── apps/
│   ├── web/                  # Next.js/React application
│   └── server/               # Fastify HTTP API and application services
├── packages/
│   ├── game-engine/          # Pure rules and state-transition decisions
│   ├── shared-types/         # Zod contracts, enums, error model
│   ├── chat-integration/     # Provider interfaces and adapters
│   └── test-support/         # Fixtures, deterministic clock/RNG, DB/API helpers
├── database/
│   └── migrations/           # Generated, reviewed Drizzle SQL migrations
├── docker-compose.yml
├── PRODUCT_SPEC.md
├── ARCHITECTURE.md
├── IMPLEMENTATION_PLAN.md
├── SECURITY.md
├── INTEGRATION_GUIDE.md
└── README.md
```

Package dependency direction is intentionally one-way:

```text
shared-types  ← game-engine
      ↑             ↑
chat-integration    |
      ↑             |
    server ─────────┘
      ↑
     web
```

`shared-types` has no application-framework or database dependency. `game-engine` may use shared domain types but never imports server, Drizzle, Fastify, or React. `apps/server` is the only production package that accesses PostgreSQL. `apps/web` consumes public contracts and never imports server internals.

## 3. Package responsibilities

### 3.1 `packages/shared-types`

Owns:

- Identifiers and enums for game, round, invitation, submission, and rematch status.
- Zod schemas for every request, response, and public event/state projection.
- `ApiError` envelope and stable error-code catalog.
- Game rules configuration schema and version identifier.
- Public active-state and completed-result types.

It does not own database entities, Fastify handlers, React state, or business orchestration. OpenAPI is generated from the same registered schemas used by routes, avoiding a hand-maintained divergent specification.

### 3.2 `packages/game-engine`

Owns pure functions for:

- Secure-input rack generation using an injected random source.
- Rack invariant checking, including vowels/consonants and repeated letters.
- Word normalization and structural rejection.
- Rack-feasibility and dictionary validation.
- Score calculation and duplicate decisions.
- Round expiration decisions using an injected current time.
- Legal game/round transitions.
- Result calculation, tie-breaking, and missed-word enumeration.

The engine accepts a `GameRules` value and a dictionary abstraction. It returns values or typed domain errors and performs no I/O. The server remains responsible for locking, persistence, identity, and mapping domain errors to HTTP.

### 3.3 `packages/chat-integration`

Defines provider-neutral interfaces:

```ts
interface ChatIdentityProvider {
  verifyLaunchToken(token: string): Promise<VerifiedChatUser>;
}

interface ChatMessageProvider {
  createGameCard(game: GameSummary): Promise<GameCardPayload>;
  sendGameInvitation(input: SendInvitationInput): Promise<void>;
}
```

It supplies:

- A development provider supporting real two-browser play and copyable URLs.
- A production adapter skeleton whose unsupported methods fail explicitly.
- Launch-token and provider payload schemas.
- Provider errors that the server translates to safe API errors.

Replay records and local sessions remain server/database responsibilities. No host-specific field is allowed into the game engine.

### 3.4 `packages/test-support`

Owns deterministic clocks and random generators, small licensed dictionary fixtures, entity factories, database reset/seed utilities, an authenticated API test client, and Playwright helpers. Production applications do not depend on this package.

### 3.5 `apps/server`

Fastify is the composition root. Internal layers are:

```text
routes/plugins → application services → repositories → Drizzle/PostgreSQL
                         ↓
                    game-engine
```

- Routes validate transport input, retrieve session identity, call one application service, and map results.
- Application services enforce authorization, acquire transactional locks, reconcile expirations, invoke the engine, and persist changes.
- Repositories encapsulate Drizzle queries and expose transaction-aware methods.
- Fastify plugins own config validation, cookies/session, CORS, security headers, rate limits, logging, database lifecycle, and OpenAPI registration.

### 3.6 `apps/web`

Next.js provides the game UI and a small typed API client. Route-level screens render from the server's public state projection. Client state contains only transient form and animation state; it is not authoritative. Server timestamps plus a measured server/client offset drive the displayed countdown. Focus/visibility changes, mutations, and periodic polling trigger reconciliation.

Polling is the baseline transport because it is reliable in embedded webviews and sufficient for two players. The API shape may later support SSE/WebSocket notification without changing persisted state or correctness.

## 4. Domain model and database schema

PostgreSQL stores normalized data. Identifiers use opaque cryptographically random UUIDs or equivalent high-entropy values generated server-side. Status fields are constrained database enums or checked text values shared with the application.

### 4.1 Tables

#### `users`

- `id` primary key
- `display_name`
- `created_at`

#### `chat_identities`

- `id` primary key
- `user_id` foreign key to `users`
- `provider`
- `external_user_id`
- `created_at`
- unique `(provider, external_user_id)`
- index on `user_id`

#### `games`

- `id` primary key
- `status`: `waiting_for_opponent | ready_check | in_progress | finalizing | completed`
- `rack` stored as a normalized six-character value
- `rules_version`, `dictionary_version`
- `version` integer for optimistic concurrency
- `created_by_user_id` foreign key
- `parent_game_id` nullable foreign key to prior game
- `created_at`, `completed_at`
- index on `(status, created_at)` for reconciliation sweeps
- unique `parent_game_id` where non-null, ensuring one accepted rematch child

#### `game_players`

- `id` primary key
- `game_id` foreign key
- `user_id` foreign key
- `seat` constrained to 1 or 2
- `joined_at`, `ready_at`
- unique `(game_id, seat)`
- unique `(game_id, user_id)`
- index on `user_id`

#### `rounds`

- `id` primary key
- `game_id` and `game_player_id` foreign keys
- `status`: `not_started | active | finished | expired`
- `started_at`, `expires_at`, `finished_at`
- finalized `score`, `valid_word_count`
- unique `(game_id, game_player_id)`
- index on `(status, expires_at)`

#### `word_submissions`

- `id` primary key
- `round_id` foreign key
- `raw_word`, `normalized_word`
- `status`: accepted or a persisted rejection category if rejected attempts are retained
- `score`
- `idempotency_key`
- `submitted_at`
- unique `(round_id, normalized_word)` for accepted submissions, implemented by a partial index if rejected attempts are stored
- unique `(round_id, idempotency_key)`
- index on `(round_id, submitted_at)`

#### `invitations`

- `id` primary key
- `game_id` foreign key
- `token_hash` unique; raw token is never stored
- optional `intended_provider` and `intended_external_user_id`
- `expires_at`, `consumed_at`, `consumed_by_user_id`, `created_at`
- index on `(game_id, expires_at)`

#### `rematch_requests`

- `id` primary key
- `game_id` foreign key
- `requested_by_player_id` foreign key
- `accepted_at`
- `resulting_game_id` nullable unique foreign key
- `created_at`
- unique `(game_id, requested_by_player_id)`

### 4.2 Migration policy

Drizzle schema definitions generate SQL migrations into `database/migrations`. Generated SQL is inspected and committed. Development and production run explicit migration commands; the application never silently creates schema at runtime. Seed data is limited to development/test helpers and dictionary metadata where appropriate.

## 5. State machines

### 5.1 Game state

```text
waiting_for_opponent
        │ seat 2 joins
        ▼
    ready_check
        │ at least one round starts
        ▼
    in_progress
        │ both rounds terminal
        ▼
     finalizing
        │ scores/result persisted
        ▼
     completed
```

`finalizing` is an internal durable guard. A transaction normally enters and leaves it atomically, but its existence permits safe recovery if finalization later gains external work. Rematch request state is represented by `rematch_requests`; a completed game's status and result remain immutable.

### 5.2 Player round state

```text
not_started ── start ──► active ── finish ──► finished
                           │
                           └── server deadline ──► expired
```

The two rounds progress independently. Starting requires seat 2 to exist and the caller to be ready. Readiness is not a synchronized timer start; each ready player starts their own 60-second round. `expires_at = started_at + rules.roundDuration` is calculated once by the server.

### 5.3 Expiration and finalization

Before reading or mutating an active round, the service compares database/server time to `expires_at`. At or after the deadline it transactionally changes the round to `expired`. After any round becomes terminal, it checks both rounds and finalizes when both are terminal.

A periodic database sweep selects overdue active rounds with `FOR UPDATE SKIP LOCKED` and applies the same service logic. This reduces result latency when both browsers disconnect; the correctness path remains request-time reconciliation, so Redis is unnecessary.

## 6. Transaction and concurrency design

### 6.1 Invitation join

1. Hash the supplied token before lookup.
2. Begin transaction and lock invitation and game rows.
3. Validate expiry, unused state, recipient restriction, and game status.
4. Insert seat 2; uniqueness constraints reject competing joins.
5. Mark invitation consumed and create the second round.
6. Transition game to `ready_check`, increment version, and commit.

Exactly one concurrent join succeeds. Retrying the same join can return the existing membership to the consuming identity; another identity receives `INVITATION_USED` or `GAME_FULL`.

### 6.2 Start, submit, and finish

- Start locks the caller's round and game, validates state/version, uses database time, and records timestamps once.
- Submit locks or otherwise serializes against the caller's round, reconciles deadline, validates against the persisted rack, and inserts using the idempotency and normalized-word constraints.
- Finish locks the round, makes terminal transition idempotently, then attempts finalization.
- Client rack, score, identity, start time, and submission time have no authority.

### 6.3 Stale updates

Every public game state includes `version`. State-sensitive mutations include `expectedVersion`. The update predicate includes the version and increments it; a miss returns `STALE_STATE` with instructions to reload. High-frequency word submission relies primarily on round state and unique keys so two valid rapid submissions do not invalidate each other solely due to game version.

### 6.4 Finalization

Finalization locks the game and both rounds in a stable order. If the game is already completed, it returns the stored result. Otherwise it verifies both rounds are terminal, recomputes totals from accepted submissions, invokes engine tie-breaking, stores round totals and completed metadata, increments the game version, and commits. No client total participates.

### 6.5 Rematch

Requests are upserted uniquely per player and completed game. Acceptance locks the original game and request records, verifies the accepter is the other player, and creates a single child game with a new rack. A unique child relationship and `resulting_game_id` make concurrent acceptance idempotent.

## 7. Authentication and security boundaries

### 7.1 Sessions

After development identity creation or verified platform launch, the server issues an opaque session in an `HttpOnly` cookie with `SameSite=Lax`, `Secure` in production, bounded lifetime, and rotation on privilege-establishing flows. Server-side session data identifies the local user and provider context. CSRF protection uses a cryptographically random token bound to the session and verified on state-changing requests, with SameSite cookies and origin validation as additional defenses; deployment CORS is an explicit allowlist.

### 7.2 Invitations

Invitation URLs contain at least 256 bits of cryptographically random entropy. Only SHA-256 token hashes are stored. Tokens are short-lived, single-use, rate-limited, and optionally bound to a verified external recipient. Logs redact URL query values, cookies, authorization values, and launch/invitation tokens.

### 7.3 Authorization

Routes never accept an authoritative player ID. Application services derive the user from the session and query membership for the target game. Result and active-state projection occurs after authorization. Object IDs alone confer no access.

### 7.4 Rate limits and headers

Invitation creation/join and word submission have separate policies. The initial single-server or sticky deployment may use in-process limits; a horizontally scaled production deployment must use a shared rate-limit store such as Redis. Fastify configures CSP appropriate to the web host, HSTS in HTTPS production, frame policy compatible only with documented host origins, MIME sniffing protection, referrer policy, and request-size limits.

## 8. API design

The JSON API is rooted at `/api/v1`.

| Method | Path                              | Purpose                                                  |
| ------ | --------------------------------- | -------------------------------------------------------- |
| `POST` | `/dev/sessions`                   | Create development identity/session                      |
| `POST` | `/launch/exchange`                | Exchange verified platform launch token for session      |
| `POST` | `/games`                          | Create game, seat 1, rack, round, and default invitation |
| `POST` | `/games/:gameId/invitations`      | Create/rotate an authorized invitation                   |
| `GET`  | `/invitations/:token`             | Return safe invitation metadata/status                   |
| `POST` | `/invitations/:token/join`        | Consume invitation and claim seat 2                      |
| `GET`  | `/games/:gameId`                  | Load caller-specific public game state                   |
| `POST` | `/games/:gameId/ready`            | Mark caller ready                                        |
| `POST` | `/games/:gameId/round/start`      | Start caller's round                                     |
| `POST` | `/games/:gameId/words`            | Submit one word                                          |
| `POST` | `/games/:gameId/round/finish`     | Finish caller's round early                              |
| `GET`  | `/games/:gameId/results`          | Load completed result only                               |
| `POST` | `/games/:gameId/rematches`        | Request rematch                                          |
| `POST` | `/games/:gameId/rematches/accept` | Accept and create child game                             |
| `GET`  | `/health`                         | Process liveness                                         |
| `GET`  | `/ready`                          | Database/dependency readiness                            |
| `GET`  | `/openapi.json`                   | Generated API specification                              |

Mutation routes accept an `Idempotency-Key` header. State-transition bodies contain `expectedVersion`; submission bodies contain only the candidate word. Successful state responses include `serverTime` and authoritative timestamps.

Errors use one envelope:

```json
{
  "error": {
    "code": "ROUND_EXPIRED",
    "message": "The round has ended.",
    "requestId": "opaque-request-id"
  }
}
```

Expected codes include `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `STALE_STATE`, `INVALID_STATE`, `INVITATION_INVALID`, `INVITATION_EXPIRED`, `INVITATION_USED`, `GAME_FULL`, `ROUND_EXPIRED`, `WORD_TOO_SHORT`, `WORD_NOT_IN_RACK`, `WORD_NOT_IN_DICTIONARY`, `DUPLICATE_WORD`, and `RATE_LIMITED`.

## 9. Public state projections and privacy

The server maps internal records to one of two discriminated response shapes.

`PlayerGameState` includes:

- Game ID, status, version, rules summary, and rack when the caller may see it.
- Caller identity, seat, readiness, round timestamps/status, accepted words, and score-so-far.
- Opponent display name, readiness, and coarse round status only.
- Server time and available actions.

It never includes the opponent's submissions, live score, rejected attempts, or word count while the game is unfinished.

`FinalGameResult` is returned only for `completed` games and includes both players' accepted words, scores, valid-word counts, missed valid rack words, and winner/draw. Tests assert absence of forbidden keys, not only expected values.

## 10. Web application architecture

Web routes correspond to product states rather than database entities:

- `/` development lobby or launch exchange.
- `/games/new` create flow.
- `/invite/[token]` invitation inspection/join.
- `/games/[gameId]` waiting, ready, active, waiting-for-opponent, and results views selected from server state.

A typed fetch client parses all responses with shared schemas. Authentication remains cookie-based. Mutation hooks generate idempotency keys and reload authoritative state after completion or `STALE_STATE`. Polling backs off on stable waiting states and becomes more frequent near active deadlines; focus and network recovery trigger immediate fetches.

The countdown renders `expiresAt - estimatedServerNow`. It can reach zero locally and disable input, but only the server determines expiry. Optimistic UI may show a submission as pending, never accepted or scored until the server confirms it.

## 11. Observability and operations

- Structured JSON logs include request ID, route, status, duration, game ID when safe, and internal error classification.
- Logs exclude raw tokens, cookies, words if privacy policy requires, and sensitive provider payloads.
- `/health` does not query dependencies and reports process liveness.
- `/ready` checks PostgreSQL and any configured mandatory provider dependency with a short timeout.
- Metrics-worthy events include join outcomes, rate-limit rejection, submission outcome codes, expiry reconciliation, finalization latency, and provider failures.
- The server handles graceful shutdown by stopping new requests and draining active database work.

## 12. Deployment topology

Local development uses Docker Compose for PostgreSQL; Redis is omitted by default. Web and server may run as workspace processes or containers. Production uses separate multi-stage Docker images for Next.js and Fastify, an externally managed PostgreSQL database, HTTPS at the ingress, explicit environment validation, and a release migration step before application rollout.

The initial deployment assumes one server replica for in-memory rate limiting. Horizontal scaling is safe for game correctness because coordination is in PostgreSQL, but requires a shared Redis-backed limiter before multiple replicas receive unpinned traffic. No application process stores authoritative state in memory.

## 13. Testing architecture

- **Engine unit tests:** rack generation/invariants, repeated letters, normalization, dictionary rules, scoring, duplicates, deadline boundary, transitions, and tie-breaking with deterministic clock/RNG.
- **Server integration tests:** real PostgreSQL transactions covering full lifecycle, invitation expiry/replay, authorization, third player, simultaneous join/submission, post-deadline rejection, reconnect projection, automatic finalization, and rematch uniqueness.
- **Contract tests:** every route response parses against shared schemas; OpenAPI generation contains every registered route.
- **Privacy tests:** unfinished projections are inspected for absence of opponent word/score fields.
- **End-to-end tests:** two isolated Playwright browser contexts create identities, share a URL, complete independent rounds, see the same result, refresh, and rematch.
- **Production smoke test:** built containers start, migrations apply, web loads, and health/readiness return expected results.

Test clocks are injected into the engine and services where possible. Database-time behavior also has boundary integration tests, preventing unit-only clock assumptions from masking production expiry bugs.

## 14. Integration seams and ownership

Parallel implementation remains safe when ownership follows package boundaries:

- Contract/engine work owns `shared-types` and `game-engine`.
- Persistence/API work owns database schema, migrations, and `apps/server`.
- Web work owns `apps/web` and consumes frozen contracts or fixtures.
- Integration/QA work owns `chat-integration`, cross-package test support, Playwright, deployment, and integration documentation.

Changes to shared request/response schemas, game rules, or database invariants require integrator review because they cross ownership seams. Root configuration has a single owner during parallel work. The first integration checkpoint freezes identifiers, enums, public projections, error codes, and service interfaces; implementation may then proceed independently.
