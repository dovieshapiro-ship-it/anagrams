type PublicPageKind = "privacy" | "marketing";

export function PublicPage({ kind }: { kind: PublicPageKind }): React.JSX.Element {
  return kind === "privacy" ? <PrivacyPolicy /> : <MarketingPage />;
}

function PublicFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <main className="public-page">
      <div className="public-page__card">
        <a className="public-page__brand" href="/" aria-label="KiwiGram home">
          KiwiGram
        </a>
        {children}
        <nav className="public-page__nav" aria-label="Legal and product links">
          <a href="/marketing">About KiwiGram</a>
          <a href="/privacy">Privacy Policy</a>
          <a href="/">Play KiwiGram</a>
        </nav>
      </div>
    </main>
  );
}

function PrivacyPolicy(): React.JSX.Element {
  return (
    <PublicFrame>
      <article className="public-page__content">
        <p className="public-page__eyebrow">KiwiGames</p>
        <h1>Privacy Policy</h1>
        <p className="public-page__updated">Effective August 4, 2026</p>

        <p>
          This Privacy Policy explains how KiwiGames collects, uses, and protects
          information when you use KiwiGram, including the KiwiGram mobile app and
          website (the “Service”).
        </p>

        <h2>Information we collect</h2>
        <ul>
          <li>
            <strong>Account information:</strong> your first name, public username,
            email address, and securely hashed password.
          </li>
          <li>
            <strong>Game information:</strong> scores, wins, submitted words, game
            results, invitations, and leaderboard records.
          </li>
          <li>
            <strong>Social information:</strong> friend requests, accepted friendships,
            and multiplayer invitations.
          </li>
          <li>
            <strong>Technical information:</strong> information needed to operate and
            secure the Service, such as session identifiers, request timestamps,
            device/browser information, and server logs.
          </li>
        </ul>

        <h2>How we use information</h2>
        <p>
          We use this information to create and secure accounts, provide solo and
          multiplayer games, validate words and scores, maintain leaderboards and
          friendships, send password-reset or login emails, prevent abuse, diagnose
          problems, and improve the Service.
        </p>

        <h2>Service providers</h2>
        <p>
          We use service providers to operate KiwiGram, including Render for
          application hosting, Supabase for managed PostgreSQL database
          infrastructure, and Resend for transactional account emails. These providers
          process information only as needed to provide their services to us and are
          governed by their own privacy and security terms.
        </p>

        <h2>Sharing and selling</h2>
        <p>
          We do not sell personal information. We do not use personal information for
          third-party advertising. Public usernames, first names, scores, and wins may
          be visible to other players through friend, multiplayer, and leaderboard
          features. We may disclose information if required by law or when necessary
          to protect users, the Service, or our legal rights.
        </p>

        <h2>Retention and security</h2>
        <p>
          We retain information while an account is active and as reasonably necessary
          to operate the Service, prevent fraud, resolve disputes, and meet legal
          obligations. We use reasonable administrative and technical safeguards, but
          no online service can guarantee absolute security.
        </p>

        <h2>Your choices</h2>
        <p>
          You may stop using the Service at any time. You may request access,
          correction, or deletion of your account information by contacting us at
          <a href="mailto:dovieshapiro@gmail.com"> dovieshapiro@gmail.com</a>. We may
          need to verify your identity before completing a request.
        </p>

        <h2>Children’s privacy</h2>
        <p>
          KiwiGram is not directed to children under 13, and we do not knowingly
          collect personal information from children under 13. If you believe a child
          has provided personal information, contact us so we can address it.
        </p>

        <h2>Changes to this policy</h2>
        <p>
          We may update this policy as KiwiGram changes. We will post the revised
          policy here and update the effective date.
        </p>

        <h2>Contact</h2>
        <p>
          Questions or privacy requests may be sent to
          <a href="mailto:dovieshapiro@gmail.com"> dovieshapiro@gmail.com</a>.
        </p>
      </article>
    </PublicFrame>
  );
}

function MarketingPage(): React.JSX.Element {
  return (
    <PublicFrame>
      <section className="public-page__hero">
        <p className="public-page__eyebrow">A word game from KiwiGames</p>
        <h1>ANAGRAMS</h1>
        <p className="public-page__lead">
          Race the clock, uncover words, and challenge friends in a polished word game
          built for quick, satisfying rounds.
        </p>
        <a className="public-page__button" href="/">
          Play KiwiGram
        </a>
      </section>

      <section className="public-page__features" aria-label="KiwiGram features">
        <div>
          <h2>Solo play</h2>
          <p>Find as many words as you can from each six-letter rack.</p>
        </div>
        <div>
          <h2>Play with friends</h2>
          <p>Invite friends, meet in a shared lobby, and compare results.</p>
        </div>
        <div>
          <h2>Climb the leaderboard</h2>
          <p>Track your personal best and compete for a top-five score.</p>
        </div>
      </section>
    </PublicFrame>
  );
}
