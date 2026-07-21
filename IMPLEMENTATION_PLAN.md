# Anagrams Implementation Plan

## Delivery approach

The application will be delivered in approval-gated milestones. Each milestone ends with a written handoff containing changed files, commands actually run, verification results, known limitations, and decisions required from the product owner. Work on the next milestone begins only after approval.

The development integration must remain playable without company credentials. Company-specific authentication and messaging work is isolated behind provider interfaces so missing production details cannot block local development or testing.

## Engineering principles

- PostgreSQL is the source of truth for identity mappings, invitations, game state, racks, deadlines, submissions, scores, and rematches.
- The server is the only authority for rules, time, validation, transitions, and results.
- Browser state is recoverable from the authenticated game-state endpoint; local storage is not authoritative.
- Public API contracts and redacted player views are defined before backend and frontend implementation diverge.
- State-changing operations are transactional, idempotent where retry is expected, and protected by database constraints.
- Tests use deterministic racks, dictionaries, and controllable timing where appropriate.
- Production claims are made only after the corresponding command or behavior has been run and observed.

## Ownership and coordination

Work may proceed in parallel after shared contracts are frozen. Directory ownership prevents overlapping edits:

| Workstream           | Primary ownership                                 | Integration boundary                                   |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| Contracts and rules  | `packages/shared-types`, `packages/game-engine`   | Zod schemas, engine functions, rule configuration      |
| Persistence and API  | `apps/server`, `database`                         | Shared request/response schemas and engine services    |
| Web experience       | `apps/web`                                        | Typed HTTP API and redacted player-state DTOs          |
| Chat integration     | `packages/chat-integration`                       | Verified launch context and invitation/card interfaces |
| Test support and E2E | `packages/test-support`, Playwright configuration | Stable API contracts and deterministic test hooks      |

Root workspace configuration and shared contracts have one integrator owner. Contract changes must be communicated before downstream code changes.

## Milestone 1: Product and technical blueprint

Deliverables:

- `PRODUCT_SPEC.md`
- `ARCHITECTURE.md`
- `IMPLEMENTATION_PLAN.md`
- `SECURITY.md`
- `INTEGRATION_GUIDE.md`

Exit criteria:

- Product flow, state model, rules, privacy requirements, and acceptance criteria are explicit.
- Package boundaries, dependency direction, API surface, persistence model, and deployment topology are defined.
- Threats, mitigations, trust boundaries, and security verification are documented.
- Development and production chat-provider responsibilities are separated.
- Later milestones and their verification gates are agreed.

Approval gate: product owner reviews the five documents and approves milestone 2.

## Milestone 2: Game engine

Scope:

- Initialize the pnpm TypeScript workspace and shared strict compiler/test configuration needed by the engine.
- Define shared rule configuration, state enums, typed errors, and public contracts needed by the pure package.
- Import and pin a legally redistributable English dictionary with its source, version, transformation process, checksum, and license.
- Implement rack generation with six letters and at least one vowel and consonant.
- Implement normalization, letter-frequency validation, dictionary lookup, duplicate detection, scoring, deadline evaluation, tie-breaking, missed-word calculation, and legal pure state transitions.
- Inject randomness and clocks to make behavior deterministic under test.

Required verification:

- Unit tests for letter generation, repeated letters, normalization, dictionary validity, scoring, duplicates, expiration, tie-breaking, and transitions.
- Type checking, linting, package build, and license/source inspection.
- Property-style or table-driven coverage for letter multiset validation and score invariants.

Approval gate: review engine API, dictionary choice/license, test output, and rule behavior.

## Milestone 3: Database and API

Scope:

- Add Docker Compose PostgreSQL and optional Redis profile.
- Implement normalized Drizzle schema, explicit generated migrations, constraints, and indexes.
- Implement Fastify composition, structured sanitized logging, environment validation, health/readiness, OpenAPI, and uniform errors.
- Implement development sessions, game creation, invitations, joining, readiness, private rounds, submissions, finishing, results, and rematches under `/api/v1`.
- Implement authorization, token hashing, replay protection, state versions, idempotency, row locking, deadline reconciliation, finalization, expiry sweeping, CORS, CSRF/origin protection, security headers, and rate limits.
- Ensure API projections never expose active opponent submissions.

Required verification:

- Generate and manually inspect migrations; start PostgreSQL and run migrations from an empty database.
- Integration tests using real PostgreSQL for the full two-player lifecycle and every required failure/race case.
- OpenAPI generation and contract synchronization test.
- Lint, type check, server tests, production server build, and live health/readiness checks.

Approval gate: review schema, API behavior, OpenAPI, security controls, and complete test results.

## Milestone 4: Web interface

Scope:

- Implement the development lobby, create/invite/join flow, ready state, private round, waiting state, results, history, and rematch.
- Use authenticated cookies and server game-state recovery; do not store authoritative identity or game data in browser storage.
- Render the countdown from server time offset and deadline while treating the server response as final.
- Add adaptive polling, mutation idempotency keys, stale-version recovery, reconnection, refresh recovery, and explicit invitation errors.
- Build a focused mobile word-game design with keyboard controls, screen-reader semantics, large touch targets, safe-area handling, and reduced-motion behavior.

Required verification:

- Component and interaction tests for all major states and errors.
- Responsive visual inspection at mobile and desktop sizes.
- Keyboard-only and screen-reader-label checks.
- Web linting, type checking, tests, and production build.

Approval gate: product owner reviews the working two-browser development experience before messaging integration work.

## Milestone 5: Messaging integration

Scope:

- Implement provider-neutral `ChatIdentityProvider` and `ChatMessageProvider` contracts.
- Complete the development provider for two-browser play using authenticated sessions and secure links.
- Add a production adapter skeleton with explicit placeholders for company authentication, IDs, conversations, cards, deep links, callbacks, and webview constraints.
- Implement signed short-lived launch-context verification and replay prevention at the server boundary.
- Keep company-specific code isolated from game rules and persistence services.

Required verification:

- Provider contract tests and development-provider integration tests.
- Invalid signature, wrong issuer/audience, expiry, replay, identity substitution, and conversation-context tests.
- Review the integration guide against the adapter placeholders.

Approval gate: review the working development integration and the exact credentials/specifications still required from the messaging company.

## Milestone 6: End-to-end testing and production packaging

Scope:

- Add Playwright fixtures using separate Alice and Bob browser contexts and an optional third-player context.
- Cover a full game, hidden opponent words, invalid/duplicate submissions, refresh/reconnect, deadline behavior, invitation expiry/replay, third-player rejection, simultaneous actions, results, and rematch.
- Add production Dockerfiles, migration release procedure, Compose production-like configuration, graceful shutdown, and readiness behavior.
- Complete `README.md`, `.env.example`, `AGENTS.md`, and exact local/test/build/deployment instructions.

Required verification sequence:

1. Install dependencies from the committed lockfile.
2. Generate and inspect database migrations.
3. Start PostgreSQL and any configured supporting service.
4. Apply migrations to an empty database.
5. Run unit tests.
6. Run integration tests.
7. Run the two-context Playwright suite.
8. Run linting and strict type checking.
9. Build all production artifacts and container images.
10. Start the production build locally.
11. Exercise health and readiness endpoints.
12. Perform a manual two-browser smoke game.

Failures are fixed and the relevant verification is rerun before completion is reported.

Approval gate: review the release candidate, command transcripts/results, known limitations, and deployment choices.

## Milestone 7: Deployment

This milestone requires an approved hosting target and authority to modify external infrastructure.

Scope:

- Configure the selected container hosting, managed PostgreSQL, secrets, allowed origins, TLS/domain, logs, and monitoring.
- Run explicit migrations as a release step rather than creating schema at runtime.
- Deploy the server and web application, verify health/readiness externally, and run a production smoke game.
- Configure the messaging-company application after credentials and platform specifications are supplied.
- Document rollback, backup, restore, key rotation, and incident procedures.

Required product-owner inputs:

- Hosting provider/account and spending constraints.
- Production domain and DNS authority.
- Database/Redis service choice or existing resources.
- Messaging authentication specification, stable identifiers, public keys or verification method, message-card schema, deep-link behavior, callbacks, allowed domains, and credentials.
- Approval before paid resources or production data changes are created.

Approval gate: explicit approval of the deployment target and external changes, followed by production acceptance.

## Definition of done

The project is complete only when two users can open separate browsers or devices, authenticate through the development provider, join through a secure invitation, play private server-timed rounds using the same rack, receive correctly finalized results, and create a rematch. The database must preserve history; required security and concurrency tests must pass; production builds and containers must start; documentation must reproduce the verified workflow; and company-specific integration gaps must be clearly marked rather than represented as complete.
