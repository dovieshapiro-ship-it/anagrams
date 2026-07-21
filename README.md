# KiwiGames Anagrams

A deployable two-player Anagrams game. Both players receive the same playable six-letter rack and complete private, independently timed 60-second rounds. PostgreSQL, the API, and the rules engine—not the browser—control timing, validation, scoring, privacy, and results.

## Game rules

- Two players, one shared six-letter rack
- A shuffled hidden six-letter English base word with two or three vowels
- No letter repeated more than twice and no awkward rare-letter clusters
- At least 15 playable dictionary words and at least one six-letter anagram
- 60 seconds per player; rounds may be played at different times
- Words use each rack letter at most once and contain 3–6 letters
- 3 letters = 100, 4 = 400, 5 = 1,200, 6 = 2,000 points
- Highest score wins; ties use valid-word count, then draw

## Local preview

Requirements: Node.js 22+, Corepack, and PostgreSQL 17 (Postgres.app works).

1. Enable the pinned package manager and install dependencies:

   ```sh
   corepack enable
   corepack pnpm install
   ```

2. Create a PostgreSQL database and apply the committed migration:

   ```sh
   createdb anagrams_test
   DATABASE_URL=postgres://$USER@127.0.0.1:5432/anagrams_test \
     corepack pnpm --filter @anagrams/server db:migrate
   ```

3. Start the API:

   ```sh
   DATABASE_URL=postgres://$USER@127.0.0.1:5432/anagrams_test \
   WEB_ORIGINS=http://localhost:3000 \
   PUBLIC_WEB_URL=http://localhost:3000 \
   COOKIE_SECURE=false \
     corepack pnpm --filter @anagrams/server dev
   ```

4. In another terminal, start the web app:

   ```sh
   corepack pnpm --filter @anagrams/web dev
   ```

5. Open `http://localhost:3000`. Create a game, then open the generated invitation in a private browser window or another browser to play as the second person.

Use `localhost` for the web address; do not mix it with `127.0.0.1`, because browser cookies are host-specific.

### Phone preview on the same Wi-Fi

After the database migration above, start both parts of the game with:

```sh
corepack pnpm dev:mobile
```

The command prints separate Mac and phone links. Keep that terminal window open, connect the phone to the same Wi-Fi as the Mac, and open the printed **Phone** link. Invitations created in this mode also use the phone-accessible address. If macOS asks whether to allow incoming connections, choose **Allow**.

This is a private local preview, not public hosting. Some guest, school, or office Wi-Fi networks prevent devices from reaching one another; use a normal home network or deploy the game to HTTPS in that case.

## Verification

```sh
corepack pnpm typecheck
corepack pnpm lint
DATABASE_URL=postgres://$USER@127.0.0.1:5432/anagrams_test corepack pnpm test
corepack pnpm build
```

The PostgreSQL integration tests use isolated test data and exercise invitation races, privacy, scoring, results, CSRF, authorization, and rematches.

## Deployment boundary

The server includes a production Dockerfile, explicit migrations, readiness checks, and secure environment validation. The web host must serve the single-page app for `/join?token=...` and proxy `/api` to the server. Production requires an HTTPS web origin, a managed PostgreSQL URL, secrets supplied by the hosting platform, and `COOKIE_SECURE` left enabled.

Messaging integration is provider-neutral. The included development provider supports local invitation links; the production placeholder fails closed until the messaging company supplies its identity-token, card, delivery, deep-link, and webview specifications. See [INTEGRATION_GUIDE.md](INTEGRATION_GUIDE.md).

Hosting, domain, and external messaging configuration are intentionally deferred until the product owner chooses the deployment target.
