# Agent Working Agreement

## Shared rules

- Preserve strict TypeScript settings and validate all boundary data.
- The server remains authoritative for identity, racks, time, word validity, score, and state transitions.
- Do not expose one player's active submissions to the opponent.
- Do not add secrets, generated build output, or unlicensed data to source control.
- Use explicit migrations; never create production schema at application startup.
- Run the narrowest relevant checks after an edit and report exactly what ran.

## Ownership

- Shared contracts: `packages/shared-types`
- Pure rules: `packages/game-engine`
- Messaging adapters: `packages/chat-integration`
- Server and database: `apps/server`, `database`
- Web: `apps/web`
- Cross-project configuration is coordinated by the root integrator.

Avoid editing another workstream's files without first communicating the contract change.
