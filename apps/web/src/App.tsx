import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WireCreateInvitationResponse,
  WireGameStateResponse,
  WireSubmitWordResponse,
} from "@anagrams/shared-types";
import type { SessionUser } from "./api";
import * as api from "./api";
import { copyInvite } from "./invite-share";

type Landing = "start" | "rules" | "friends";
type GameMode = "solo" | "friend";
type AuthView = "welcome" | "signup" | "login" | "sent";

export function App(): React.JSX.Element {
  const initial = new URL(window.location.href);
  const magicToken = new URLSearchParams(window.location.hash.slice(1)).get("magic");
  const [session, setSession] = useState<SessionUser | null>();
  const [authView, setAuthView] = useState<AuthView>("welcome");
  const [developmentMagicLink, setDevelopmentMagicLink] = useState("");
  const [landing, setLanding] = useState<Landing>(
    initial.searchParams.has("token") ? "rules" : "start",
  );
  const [token, setToken] = useState(initial.searchParams.get("token"));
  const [mode, setMode] = useState<GameMode>(
    initial.searchParams.has("token") ? "friend" : "solo",
  );
  const [gameId, setGameId] = useState(initial.searchParams.get("game"));
  const [state, setState] = useState<WireGameStateResponse>();
  const [invitation, setInvitation] = useState<WireCreateInvitationResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [friendInviteCount, setFriendInviteCount] = useState(0);
  const automaticStartKey = useRef<string | undefined>(undefined);
  const sessionBootstrapStarted = useRef(false);

  useEffect(() => {
    if (sessionBootstrapStarted.current) return;
    sessionBootstrapStarted.current = true;
    void (async () => {
      try {
        if (magicToken) {
          const continueTo = await api.consumeMagicLink(magicToken);
          window.history.replaceState({}, "", continueTo ?? "/");
          if (continueTo) {
            const continued = new URL(continueTo, window.location.origin);
            setToken(continued.searchParams.get("token"));
            if (continued.searchParams.has("token")) {
              setMode("friend");
              setLanding("rules");
            }
          }
        }
        setSession(await api.getMe());
        setError("");
      } catch (caught) {
        setSession(null);
        setError(messageOf(caught));
      }
    })();
  }, []);

  function resetToStart(): void {
    setState(undefined);
    setGameId(null);
    setInvitation(undefined);
    setToken(null);
    setMode("solo");
    setLanding("start");
    setBusy(false);
    setError("");
    window.history.replaceState({}, "", "/");
  }

  function chooseMode(nextMode: GameMode): void {
    setToken(null);
    setInvitation(undefined);
    setMode(nextMode);
    setError("");
    setLanding("rules");
    window.history.replaceState({}, "", "/");
  }

  const load = useCallback(async (): Promise<void> => {
    if (!gameId || !session) return;
    try {
      setState(await api.getGame(gameId));
      setError("");
    } catch (caught) {
      if (
        caught instanceof api.ApiClientError &&
        ["UNAUTHENTICATED", "GAME_NOT_FOUND", "NOT_FOUND"].includes(caught.code)
      ) {
        setGameId(null);
        setState(undefined);
        setInvitation(undefined);
        setLanding("start");
        if (caught instanceof api.ApiClientError && caught.code === "UNAUTHENTICATED")
          setSession(null);
        setError(token ? "" : "That game is no longer available.");
        if (!token) window.history.replaceState({}, "", "/");
      } else setError(messageOf(caught));
    }
  }, [gameId, session, token]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!session || gameId) return;
    void api
      .getFriendGameInvitations()
      .then((items) => setFriendInviteCount(items.length))
      .catch(() => setFriendInviteCount(0));
  }, [gameId, session]);
  useEffect(() => {
    if (!gameId || !state) return undefined;
    const active = state.me.round?.status === "active";
    const timer = window.setInterval(() => void load(), active ? 1_000 : 2_500);
    const recover = (): void => {
      if (!document.hidden) void load();
    };
    window.addEventListener("online", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [gameId, load, state]);
  useEffect(() => {
    if (
      !gameId ||
      !state ||
      busy ||
      state.game.status !== "in_progress" ||
      state.me.round?.status !== "not_started"
    )
      return;
    const key = `${gameId}:${String(state.game.version)}`;
    if (automaticStartKey.current === key) return;
    automaticStartKey.current = key;
    setBusy(true);
    setError("");
    void api
      .startRound(gameId, state.game.version)
      .then(load)
      .catch(async (caught: unknown) => {
        setError(messageOf(caught));
        await load();
      })
      .finally(() => setBusy(false));
  }, [busy, gameId, load, state]);

  async function beginGame(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const invitationToken = token;
      const id = invitationToken
        ? await api.joinInvitation(invitationToken)
        : mode === "solo"
          ? await api.createSoloGame()
          : await api.createGame();
      if (invitationToken) setToken(null);
      setGameId(id);
      setLanding("rules");
      replaceLocation(id);
      if (!invitationToken && mode === "friend")
        setInvitation(await api.createInvitation(id));
      let next = await api.getGame(id);
      if (!invitationToken && mode === "solo") {
        if (next.me.status === "joined") {
          await api.markReady(id, next.game.version);
          next = await api.getGame(id);
        }
        if (next.me.round?.status === "not_started") {
          await api.startRound(id, next.game.version);
          next = await api.getGame(id);
        }
      }
      setState(next);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function sendMagicLink(
    email: string,
    displayName?: string,
  ): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const result = await api.requestMagicLink({
        email,
        ...(displayName ? { displayName } : {}),
        continuePath: `${window.location.pathname}${window.location.search}`,
      });
      setDevelopmentMagicLink(result.developmentMagicLink ?? "");
      setAuthView("sent");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function signOut(): Promise<void> {
    setBusy(true);
    try {
      await api.logout();
      resetToStart();
      setSession(null);
      setAuthView("welcome");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function returnHome(): Promise<void> {
    resetToStart();
    try {
      setSession(await api.getMe());
    } catch {
      setSession(null);
    }
  }

  async function exitCurrentGame(): Promise<void> {
    if (!gameId || !state) {
      await returnHome();
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (state.me.round?.status === "active")
        await api.finishRound(gameId, state.game.version);
      await returnHome();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  if (session === undefined)
    return (
      <main className="game-table">
        <AuthLoading />
      </main>
    );

  if (session === null)
    return (
      <main className="game-table">
        <AuthScreen
          view={authView}
          busy={busy}
          error={error}
          developmentMagicLink={developmentMagicLink}
          onView={setAuthView}
          onSubmit={(email, name) => void sendMagicLink(email, name)}
        />
      </main>
    );

  async function act<T>(action: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError("");
    try {
      const result = await action();
      await load();
      return result;
    } catch (caught) {
      setError(messageOf(caught));
      await load();
    } finally {
      setBusy(false);
    }
    return undefined;
  }

  function moveTo(id: string): void {
    setGameId(id);
    setState(undefined);
    setInvitation(undefined);
    replaceLocation(id);
  }

  async function createSoloRematch(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const id = await api.createSoloGame();
      setMode("solo");
      setLanding("rules");
      setInvitation(undefined);
      setGameId(id);
      replaceLocation(id);
      setState(await api.getGame(id));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!state || !gameId)
    return (
      <main className="game-table">
        {landing === "start" && (
          <StartScreen
            session={session}
            error={error}
            onSolo={() => chooseMode("solo")}
            onFriend={() => chooseMode("friend")}
            onFriends={() => setLanding("friends")}
            friendInviteCount={friendInviteCount}
            onLogout={() => void signOut()}
          />
        )}
        {landing === "friends" && (
          <FriendsScreen
            onBack={() => setLanding("start")}
            onJoin={(id) => moveTo(id)}
            onInvitationCount={setFriendInviteCount}
            username={session.username}
            onUsernameSet={(username) =>
              setSession((current) => current ? { ...current, username } : current)
            }
          />
        )}
        {landing === "rules" && (
          <RulesScreen
            onBack={() => setLanding("start")}
            onPlay={() => void beginGame()}
          />
        )}
      </main>
    );

  const currentMode = rematchMode(state, mode);

  if (state.game.status === "completed")
    return (
      <main className="game-table">
        <ResultsScreen
          state={state}
          busy={busy}
          error={error}
          onRequest={() =>
            currentMode === "solo"
              ? void createSoloRematch()
              : void act(() => api.requestRematch(gameId))
          }
          onAccept={(requestId) =>
            void act(async () =>
              moveTo(await api.acceptRematch(gameId, requestId)),
            )
          }
          onExit={() => void returnHome()}
        />
      </main>
    );
  if (state.me.round?.status === "active" && state.game.rack)
    return (
      <main className="game-table">
        <PlayScreen
          state={state}
          busy={busy}
          error={error}
          onSubmit={async (word) => {
            const result = await api.submitWord(gameId, word);
            await load();
            return result;
          }}
          onFinish={() =>
            void act(() => api.finishRound(gameId, state.game.version))
          }
          onExit={() => void exitCurrentGame()}
        />
      </main>
    );
  return (
    <main className="game-table">
      <WaitingScreen
        state={state}
        {...(invitation ? { invitation } : {})}
        busy={busy}
        error={error}
        onInvite={async () => {
          const created = await act(() => api.createInvitation(gameId));
          if (created) setInvitation(created);
          return created;
        }}
        onInviteFriend={async (friendUserId) => {
          const created = await act(() =>
            api.createFriendInvitation(gameId, friendUserId),
          );
          return created;
        }}
        onReady={() =>
          void act(() => api.markReady(gameId, state.game.version))
        }
        onStart={() =>
          void act(() => api.startRound(gameId, state.game.version))
        }
        onExit={() => void exitCurrentGame()}
      />
    </main>
  );
}

function StartScreen(props: {
  readonly session: SessionUser;
  readonly error: string;
  readonly onSolo: () => void;
  readonly onFriend: () => void;
  readonly onFriends: () => void;
  readonly friendInviteCount: number;
  readonly onLogout: () => void;
}): React.JSX.Element {
  return (
    <section className="start-screen screen" aria-labelledby="start-title">
      <h1 id="start-title">ANAGRAMS</h1>
      <div className="home-account">
        <span className="welcome-name">WELCOME, {props.session.displayName.toUpperCase()}</span>
        <span className="trophy-stat" aria-label={`${String(props.session.wins)} multiplayer wins`}>
          <span className="trophy-icon" aria-hidden="true" />
          <strong>{props.session.wins}</strong>
        </span>
      </div>
      <div className="title-ornament start-ornament" aria-hidden="true" />
      <KiwiFruit className="start-kiwi" />
      <p className="brand-mark">KiwiGames</p>
      <div className="mode-actions">
        <button className="table-button" type="button" onClick={props.onSolo}>
          SOLO PLAY
        </button>
        <button className="table-button" type="button" onClick={props.onFriend}>
          INVITE A FRIEND
        </button>
      </div>
      <p className="game-facts">
        60 SECONDS <span aria-hidden="true">•</span> 6 LETTERS
      </p>
      <button className="friends-link" type="button" onClick={props.onFriends}>
        FRIENDS
        {props.friendInviteCount > 0 && (
          <span className="friend-badge" aria-label={`${String(props.friendInviteCount)} pending game invitations`}>
            {props.friendInviteCount}
          </span>
        )}
      </button>
      <button className="logout-link" type="button" onClick={props.onLogout}>
        LOG OUT
      </button>
      {props.error && (
        <p className="start-error" role="status">
          {props.error}
        </p>
      )}
      <WalnutRail />
    </section>
  );
}

function RulesScreen(props: {
  readonly onBack: () => void;
  readonly onPlay: () => void;
}): React.JSX.Element {
  return (
    <section className="rules-screen screen" aria-labelledby="rules-title">
      <button
        className="round-back game-exit"
        type="button"
        onClick={props.onBack}
        aria-label="Back to title"
      >
        ←
      </button>
      <h1 id="rules-title" className="screen-title">
        HOW TO PLAY
      </h1>
      <div className="title-ornament" aria-hidden="true">
        <KiwiFruit className="ornament-kiwi" />
      </div>
      <div className="ivory-panel rules-sheet">
        <div className="rule-row">
          <span className="rule-medallion">◷</span>
          <p>
            Make as many words
            <br />
            as you can in 60 seconds
          </p>
        </div>
        <div className="rule-row">
          <span className="rule-medallion">A</span>
          <p>
            Use each letter
            <br />
            only once
          </p>
        </div>
        <div className="rule-row">
          <span className="rule-medallion">3+</span>
          <p>
            Words must be
            <br />3 letters or more
          </p>
        </div>
        <div className="score-copy">
          <h2>SCORING</h2>
          <p>
            3 = 100&nbsp;&nbsp; · &nbsp;&nbsp;4 = 400
            <br />5 = 1200&nbsp; · &nbsp;6 = 2000
          </p>
        </div>
      </div>
      <button className="table-button" type="button" onClick={props.onPlay}>
        START ROUND
      </button>
      <WalnutRail />
    </section>
  );
}

function AuthLoading(): React.JSX.Element {
  return (
    <section className="auth-screen screen" aria-live="polite">
      <h1 className="screen-title">ANAGRAMS</h1>
      <div className="title-ornament" aria-hidden="true" />
      <p className="auth-loading">OPENING THE CLUB…</p>
      <WalnutRail />
    </section>
  );
}

function AuthScreen(props: {
  readonly view: AuthView;
  readonly busy: boolean;
  readonly error: string;
  readonly developmentMagicLink: string;
  readonly onView: (view: AuthView) => void;
  readonly onSubmit: (email: string, displayName?: string) => void;
}): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  if (props.view === "welcome")
    return (
      <section className="auth-screen start-screen screen" aria-labelledby="welcome-title">
        <div className="auth-brand-cluster">
          <h1 id="welcome-title">ANAGRAMS</h1>
          <div className="title-ornament start-ornament auth-ornament" aria-hidden="true" />
          <KiwiFruit className="start-kiwi" />
          <p className="brand-mark">KiwiGames</p>
        </div>
        <div className="mode-actions">
          <button className="table-button" type="button" onClick={() => props.onView("login")}>LOG IN</button>
          <button className="table-button auth-secondary" type="button" onClick={() => props.onView("signup")}>CREATE ACCOUNT</button>
        </div>
        <p className="game-facts">60 SECONDS <span aria-hidden="true">•</span> 6 LETTERS</p>
        <StatusMessage error={props.error} />
        <WalnutRail />
      </section>
    );
  if (props.view === "sent")
    return (
      <section className="auth-screen auth-sent-screen screen" aria-labelledby="email-title">
        <h1 id="email-title" className="screen-title">CHECK YOUR EMAIL</h1>
        <div className="title-ornament" aria-hidden="true" />
        <div className="ivory-panel auth-sheet">
          <span className="auth-seal" aria-hidden="true">✉</span>
          <p>We sent a secure sign-in link to <strong>{email}</strong>.</p>
          <p className="auth-note">The link expires in 15 minutes.</p>
          {props.developmentMagicLink && (
            <a className="table-button development-link" href={props.developmentMagicLink}>OPEN TEST SIGN-IN LINK</a>
          )}
          <button className="text-link" type="button" onClick={() => props.onView("login")}>USE A DIFFERENT EMAIL</button>
        </div>
        <WalnutRail />
      </section>
    );
  const signup = props.view === "signup";
  return (
    <section className="auth-screen screen" aria-labelledby="auth-title">
      <h1 id="auth-title" className="screen-title">{signup ? "JOIN THE CLUB" : "WELCOME BACK"}</h1>
      <div className="title-ornament" aria-hidden="true" />
      <form
        className="ivory-panel auth-sheet"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit(email, signup ? name : undefined);
        }}
      >
        {signup && <><label className="field-label" htmlFor="signup-name">YOUR FIRST NAME</label><input className="club-input" id="signup-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoComplete="nickname" /></>}
        <label className="field-label" htmlFor="account-email">EMAIL</label>
        <input className="club-input" id="account-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} autoComplete="email" autoFocus />
        <button
          className="table-button"
          type="submit"
          disabled={props.busy || !email.trim() || (signup && !name.trim())}
        >
          {props.busy ? "PLEASE WAIT…" : signup ? "CREATE ACCOUNT" : "EMAIL ME A MAGIC LINK"}
        </button>
        <StatusMessage error={props.error} />
        <button className="text-link" type="button" onClick={() => props.onView(signup ? "login" : "signup")}>{signup ? "ALREADY A MEMBER? LOG IN" : "NEW HERE? CREATE ACCOUNT"}</button>
      </form>
      <button className="round-back" type="button" onClick={() => props.onView("welcome")} aria-label="Back to welcome">←</button>
      <WalnutRail />
    </section>
  );
}

export function FriendsScreen(props: {
  readonly onBack: () => void;
  readonly onJoin: (gameId: string) => void;
  readonly onInvitationCount?: (count: number) => void;
  readonly username?: string | null;
  readonly onUsernameSet?: (username: string) => void;
}): React.JSX.Element {
  const [data, setData] = useState<api.FriendsResponse>();
  const [gameInvites, setGameInvites] = useState<
    readonly api.FriendGameInvitation[]
  >([]);
  const [username, setUsername] = useState("");
  const [searchResult, setSearchResult] = useState<api.FriendSearchResponse>();
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [claimUsername, setClaimUsername] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [friends, invitations] = await Promise.all([
        api.getFriends(),
        api.getFriendGameInvitations(),
      ]);
      setData(friends);
      setGameInvites(invitations);
      props.onInvitationCount?.(invitations.length);
      setMessage("");
    } catch (caught) {
      setMessage(messageOf(caught));
    }
  }, [props.onInvitationCount]);

  useEffect(() => {
    if (props.username === null) return;
    void refresh();
  }, [props.username, refresh]);

  async function run(id: string, action: () => Promise<void>): Promise<void> {
    setBusyId(id);
    setMessage("");
    try {
      await action();
      setSearchResult(undefined);
      await refresh();
    } catch (caught) {
      setMessage(messageOf(caught));
    } finally {
      setBusyId("");
    }
  }

  async function search(): Promise<void> {
    const exact = username.trim();
    if (!exact) return;
    setBusyId("search");
    setMessage("");
    try {
      const result = await api.searchFriend(exact);
      setSearchResult(result);
      if (!result.user) setMessage(`No member found for “${exact}”.`);
    } catch (caught) {
      setMessage(messageOf(caught));
    } finally {
      setBusyId("");
    }
  }

  async function claim(): Promise<void> {
    const normalized = claimUsername.trim().toLowerCase();
    if (!normalized) return;
    setBusyId("username");
    setMessage("");
    try {
      const claimed = await api.setUsername(normalized);
      props.onUsernameSet?.(claimed);
      await refresh();
    } catch (caught) {
      setMessage(messageOf(caught));
    } finally {
      setBusyId("");
    }
  }

  if (props.username === null)
    return (
      <section className="friends-screen screen" aria-labelledby="username-title">
        <button className="round-back" type="button" onClick={props.onBack} aria-label="Back to home">←</button>
        <h1 id="username-title" className="screen-title">CHOOSE YOUR USERNAME</h1>
        <div className="title-ornament" aria-hidden="true" />
        <form className="ivory-panel username-sheet" onSubmit={(event) => { event.preventDefault(); void claim(); }}>
          <p>This is how friends will find you. You can choose it once.</p>
          <label className="field-label" htmlFor="claim-username">USERNAME</label>
          <input id="claim-username" className="club-input" value={claimUsername} onChange={(event) => setClaimUsername(event.target.value.toLowerCase().replace(/[^a-z0-9_]/gu, ""))} minLength={3} maxLength={20} autoComplete="off" placeholder="dovie_1" />
          <small>3–20 letters, numbers, or underscores</small>
          <button className="table-button" type="submit" disabled={busyId === "username" || claimUsername.length < 3}>{busyId === "username" ? "SAVING…" : "CLAIM USERNAME"}</button>
          {message && <p className="friend-message" role="status">{message}</p>}
        </form>
        <WalnutRail />
      </section>
    );

  return (
    <section className="friends-screen screen" aria-labelledby="friends-title">
      <button className="round-back" type="button" onClick={props.onBack} aria-label="Back to home">←</button>
      <h1 id="friends-title" className="screen-title">FRIENDS</h1>
      <div className="title-ornament" aria-hidden="true"><KiwiFruit className="ornament-kiwi" /></div>
      <div className="ivory-panel friends-sheet">
        <form className="friend-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <label className="field-label" htmlFor="friend-username">FIND BY EXACT USERNAME</label>
          <div><input id="friend-username" className="club-input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" /><button type="submit" disabled={!username.trim() || busyId === "search"}>FIND</button></div>
        </form>
        {searchResult?.user && (
          <FriendRow friend={searchResult.user} detail={`@${searchResult.user.username}`} actions={
            searchResult.relationship === "none" ? <button type="button" disabled={Boolean(busyId)} onClick={() => void run("request", () => api.sendFriendRequest(searchResult.user?.username ?? ""))}>ADD</button> : <span className="friend-state">{searchResult.relationship.toUpperCase()}</span>
          } />
        )}
        {gameInvites.length > 0 && <FriendSection title="GAME INVITATIONS">{gameInvites.map((invite) => <FriendRow key={invite.id} friend={invite.inviter} detail="invited you to play" actions={<><button type="button" disabled={Boolean(busyId)} onClick={() => void run(invite.id, async () => props.onJoin(await api.acceptFriendGameInvitation(invite.id)))}>JOIN</button><button type="button" className="quiet-action" disabled={Boolean(busyId)} onClick={() => void run(invite.id, () => api.declineFriendGameInvitation(invite.id))}>DECLINE</button></>} />)}</FriendSection>}
        {(data?.incomingRequests.length ?? 0) > 0 && <FriendSection title="REQUESTS">{data?.incomingRequests.map((request) => <FriendRow key={request.id} friend={request.user} detail={`@${request.user.username}`} actions={<><button type="button" disabled={Boolean(busyId)} onClick={() => void run(request.id, () => api.respondToFriendRequest(request.id, "accept"))}>ACCEPT</button><button type="button" className="quiet-action" disabled={Boolean(busyId)} onClick={() => void run(request.id, () => api.respondToFriendRequest(request.id, "decline"))}>DECLINE</button></>} />)}</FriendSection>}
        <FriendSection title="YOUR FRIENDS">{data?.friends.length ? data.friends.map((friend) => <FriendRow key={friend.userId} friend={friend} detail={`@${friend.username}`} actions={<button type="button" className="quiet-action" disabled={Boolean(busyId)} onClick={() => void run(friend.userId, () => api.removeFriend(friend.userId))}>REMOVE</button>} />) : <p className="empty-friends">Your club table is waiting for friends.</p>}</FriendSection>
        {(data?.outgoingRequests.length ?? 0) > 0 && <FriendSection title="SENT">{data?.outgoingRequests.map((request) => <FriendRow key={request.id} friend={request.user} detail="Request pending" actions={<span className="friend-state">PENDING</span>} />)}</FriendSection>}
        {message && <p className="friend-message" role="status">{message}</p>}
      </div>
      <WalnutRail />
    </section>
  );
}

function FriendSection(props: { readonly title: string; readonly children: React.ReactNode }): React.JSX.Element {
  return <section className="friend-section"><h2>{props.title}</h2>{props.children}</section>;
}

function FriendRow(props: { readonly friend: api.FriendSummary; readonly detail: string; readonly actions: React.ReactNode }): React.JSX.Element {
  return <div className="friend-row"><span className="friend-monogram" aria-hidden="true">{props.friend.displayName.slice(0, 1).toUpperCase()}</span><span className="friend-identity"><strong>{props.friend.displayName}</strong><small>{props.detail}</small></span><span className="friend-actions">{props.actions}</span></div>;
}

function WaitingScreen(props: {
  readonly state: WireGameStateResponse;
  readonly invitation?: WireCreateInvitationResponse;
  readonly busy: boolean;
  readonly error: string;
  readonly onInvite: () => Promise<WireCreateInvitationResponse | undefined>;
  readonly onInviteFriend: (friendUserId: string) => Promise<api.FriendInvitationCreated | undefined>;
  readonly onReady: () => void;
  readonly onStart: () => void;
  readonly onExit: () => void;
}): React.JSX.Element {
  const [shareStatus, setShareStatus] = useState("");
  const [friends, setFriends] = useState<readonly api.FriendSummary[]>([]);
  const [invitedFriendId, setInvitedFriendId] = useState("");
  const copyToastTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (copyToastTimer.current !== undefined)
        window.clearTimeout(copyToastTimer.current);
    },
    [],
  );
  const waitingOpponent = !props.state.opponent;
  useEffect(() => {
    if (!waitingOpponent) return;
    void api.getFriends().then((result) => setFriends(result.friends)).catch(() => setFriends([]));
  }, [waitingOpponent]);
  const canStart =
    props.state.game.status === "in_progress" &&
    props.state.me.round?.status === "not_started";
  const needsReady =
    !props.state.me.status.includes("ready") &&
    props.state.me.status === "joined";
  async function copy(): Promise<void> {
    const invitation = props.invitation ?? (await props.onInvite());
    if (!invitation) return;
    const result = await copyInvite(invitation.invitationUrl);
    setShareStatus(result === "copied" ? "Link copied" : "Copy failed");
    if (copyToastTimer.current !== undefined)
      window.clearTimeout(copyToastTimer.current);
    copyToastTimer.current = window.setTimeout(() => setShareStatus(""), 1_000);
  }
  return (
    <>
      <RulesScreen
        onBack={() => window.location.assign("/")}
        onPlay={
          canStart
            ? props.onStart
            : needsReady
              ? props.onReady
              : () => undefined
        }
      />
      <div className="modal-scrim" role="presentation">
        <div
          className="ivory-panel compact-panel modal-panel"
          aria-label="Game setup"
        >
          <button
            className="round-back game-exit modal-exit"
            type="button"
            onClick={props.onExit}
            aria-label="Exit to home"
          >
            ←
          </button>
          {waitingOpponent ? (
            <>
              {friends.length > 0 && (
                <div className="invite-friends" aria-label="Invite a friend">
                  <h2>INVITE A FRIEND</h2>
                  {friends.map((friend) => (
                    <FriendRow key={friend.userId} friend={friend} detail={`@${friend.username}`} actions={<button type="button" disabled={props.busy || Boolean(invitedFriendId)} onClick={() => { setInvitedFriendId(friend.userId); void props.onInviteFriend(friend.userId).then((sent) => { if (sent) setShareStatus(`Invitation sent to ${friend.displayName}`); }).finally(() => setInvitedFriendId("")); }}>{invitedFriendId === friend.userId ? "SENDING…" : "INVITE"}</button>} />
                  ))}
                  <div className="invite-divider"><span>OR</span></div>
                </div>
              )}
              <button
                className="table-button copy-invite-button"
                type="button"
                onClick={() => void copy()}
                disabled={props.busy}
              >
                COPY LINK
              </button>
              <WaitingCopy />
              {shareStatus && (
                <p className="copy-toast" role="status">
                  {shareStatus}
                </p>
              )}
            </>
          ) : canStart ? (
            <>
              <button
                className="table-button"
                type="button"
                onClick={props.onStart}
                disabled={props.busy}
              >
                START ROUND
              </button>
            </>
          ) : needsReady ? (
            <>
              <button
                className="table-button"
                type="button"
                onClick={props.onReady}
                disabled={props.busy}
              >
                START ROUND
              </button>
            </>
          ) : (
            <>
              <WaitingCopy />
            </>
          )}
          <StatusMessage error={props.error} />
        </div>
      </div>
    </>
  );
}

function WaitingCopy(): React.JSX.Element {
  const [dotCount, setDotCount] = useState(1);
  useEffect(() => {
    const timer = window.setInterval(
      () => setDotCount((current) => (current === 3 ? 1 : current + 1)),
      450,
    );
    return () => window.clearInterval(timer);
  }, []);
  return (
    <p className="wait-copy" aria-label="Waiting for opponent">
      WAITING FOR OPPONENT
      <span className="waiting-dots" aria-hidden="true">
        {".".repeat(dotCount)}
      </span>
    </p>
  );
}

interface RackTile {
  readonly id: number;
  readonly letter: string;
}

function makeRack(letters: readonly string[]): readonly RackTile[] {
  return letters.map((letter, id) => ({ id, letter }));
}

export function PlayScreen(props: {
  readonly state: WireGameStateResponse;
  readonly busy: boolean;
  readonly error: string;
  readonly onSubmit: (word: string) => Promise<WireSubmitWordResponse>;
  readonly onFinish: () => void;
  readonly onExit: () => void;
}): React.JSX.Element {
  const [feedback, setFeedback] = useState("");
  const originalRack = Array.from(props.state.game.rack ?? "");
  const [rack, setRack] = useState<readonly RackTile[]>(() =>
    makeRack(originalRack),
  );
  const [selected, setSelected] = useState<readonly number[]>([]);
  const [anagramFound, setAnagramFound] = useState(false);
  const [celebrationWord, setCelebrationWord] = useState("");
  const entry = selected.map((id) => originalRack[id] ?? "").join("");
  const [seconds, setSeconds] = useState(() => remaining(props.state));
  const ended = useRef(false);
  const toastTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const timer = window.setInterval(
      () => setSeconds(remaining(props.state)),
      250,
    );
    return () => window.clearInterval(timer);
  }, [props.state]);
  useEffect(
    () => () => {
      if (toastTimer.current !== undefined)
        window.clearTimeout(toastTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (seconds === 0 && !ended.current) {
      ended.current = true;
      props.onFinish();
    }
  }, [props, seconds]);
  async function submit(): Promise<void> {
    try {
      const result = await props.onSubmit(entry);
      setFeedback(
        result.accepted
          ? `${result.normalizedWord} — ${result.score.toLocaleString()} points.`
          : rejectionMessage(result.rejectionCode),
      );
      if (result.accepted && result.normalizedWord.length === 6) {
        setAnagramFound(true);
        setCelebrationWord(result.normalizedWord);
        toastTimer.current = window.setTimeout(() => {
          setAnagramFound(false);
          setCelebrationWord("");
        }, 1_000);
      }
      setSelected([]);
      setRack(makeRack(originalRack));
    } catch (caught) {
      setFeedback(messageOf(caught));
    }
  }
  function toggleTile(id: number): void {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((selectedId) => selectedId !== id)
        : current.length < 6
          ? [...current, id]
          : current,
    );
  }
  function removeLast(): void {
    setSelected((current) => current.slice(0, -1));
  }
  function typeLetter(letter: string): void {
    const tile = rack.find(
      (candidate) =>
        candidate.letter === letter.toLowerCase() &&
        !selected.includes(candidate.id),
    );
    if (tile && selected.length < 6)
      setSelected((current) => [...current, tile.id]);
  }
  useEffect(() => {
    const handlePhysicalKeyboard = (event: KeyboardEvent): void => {
      if (event.key === "Backspace") {
        event.preventDefault();
        removeLast();
      } else if (/^[a-z]$/i.test(event.key)) {
        event.preventDefault();
        typeLetter(event.key);
      }
    };
    window.addEventListener("keydown", handlePhysicalKeyboard);
    return () => window.removeEventListener("keydown", handlePhysicalKeyboard);
  });
  return (
    <section className="play-screen screen" aria-labelledby="play-title">
      <h1 id="play-title" className="sr-only">
        Anagrams round
      </h1>
      <button
        className="round-back game-exit play-exit"
        type="button"
        onClick={props.onExit}
        disabled={props.busy}
        aria-label="Finish round and exit to home"
      >
        ←
      </button>
      <div className="play-topbar">
        <button
          className="round-shuffle"
          type="button"
          aria-label="Shuffle letters"
          onClick={() =>
            setRack((current) => [
              ...current.slice(1),
              ...(current[0] ? [current[0]] : []),
            ])
          }
        >
          ⤨
        </button>
        <strong
          className="timer-pill"
          aria-label={`${String(seconds)} seconds remaining`}
        >
          00:{String(seconds).padStart(2, "0")}
        </strong>
      </div>
      <div className="ivory-panel score-strip">
        <span>WORDS: {props.state.me.validWordCount}</span>
        <span>SCORE: {props.state.me.score.toLocaleString()}</span>
      </div>
      <div className="ivory-panel word-board">
        <p>Make as many words as you can!</p>
        <button
          className={`word-slots${anagramFound ? " anagram-glow" : ""}`}
          type="button"
          aria-label="Selected word"
        >
          {Array.from({ length: 6 }, (_, index) => (
            <span key={String(index)}>
              {(anagramFound ? celebrationWord : entry)[index] ?? ""}
            </span>
          ))}
        </button>
      </div>
      <form
        className="entry-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <button
          className="table-button enter-button"
          type="submit"
          disabled={props.busy || !entry}
        >
          ENTER
        </button>
        <p id="feedback" className="round-feedback" aria-live="polite">
          {props.error || feedback}
        </p>
      </form>
      <div className="rack" role="list" aria-label="Available letters">
        {rack.map((tile) => (
          <button
            role="listitem"
            type="button"
            key={String(tile.id)}
            data-used={selected.includes(tile.id)}
            aria-pressed={selected.includes(tile.id)}
            aria-disabled={selected.includes(tile.id)}
            aria-label={`${tile.letter.toUpperCase()} tile, ${selected.includes(tile.id) ? "used; activate to return" : "available"}`}
            onPointerDown={() => {
              if (document.activeElement instanceof HTMLInputElement)
                document.activeElement.blur();
            }}
            onClick={() => toggleTile(tile.id)}
          >
            {tile.letter}
          </button>
        ))}
      </div>
      {anagramFound && (
        <div className="anagram-toast" role="status">
          Anagram found!
        </div>
      )}
      <WalnutRail />
    </section>
  );
}

function ResultsScreen(props: {
  readonly state: WireGameStateResponse;
  readonly busy: boolean;
  readonly error: string;
  readonly onRequest: () => void;
  readonly onAccept: (id: string) => void;
  readonly onExit: () => void;
}): React.JSX.Element {
  const results = props.state.results ?? [];
  const me = results.find((item) => item.playerId === props.state.me.id);
  const other = results.find((item) => item.playerId !== props.state.me.id);
  const won = props.state.game.winnerPlayerId === props.state.me.id;
  const solo = other?.displayName === "Kiwi";
  const pending = props.state.pendingRematch;
  return (
    <section className="results-screen screen" aria-labelledby="results-title">
      <h1 id="results-title" className="screen-title">
        ROUND RESULTS
      </h1>
      <div className="title-ornament" aria-hidden="true">
        <KiwiFruit className="ornament-kiwi" />
      </div>
      <div className="ivory-panel results-sheet">
        <div className="results-grid">
          <ResultColumn
            name={me?.displayName ?? "YOU"}
            score={me?.score ?? 0}
            words={me?.words ?? []}
            winner={!solo && won}
          />
          <div className="versus" aria-hidden="true">
            VS
          </div>
          {solo ? (
            <KiwiWordsColumn words={sixLetterKiwiWords(other)} />
          ) : (
            <ResultColumn
              name={other?.displayName ?? "OPPONENT"}
              score={other?.score ?? 0}
              words={other?.words ?? []}
              winner={Boolean(
                other && props.state.game.winnerPlayerId === other.playerId,
              )}
            />
          )}
        </div>
      </div>
      <div className="winner-banner">
        {!solo && won ? "YOU WIN!" : "ROUND COMPLETE"}
      </div>
      <div className="praise-card">
        <strong>{solo || won ? "GREAT JOB!" : "WELL PLAYED!"}</strong>
      </div>
      {pending?.canAccept ? (
        <button
          className="table-button"
          type="button"
          disabled={props.busy}
          onClick={() => props.onAccept(pending.id)}
        >
          ACCEPT REMATCH
        </button>
      ) : pending ? (
        <p>Rematch requested. Waiting for your opponent…</p>
      ) : (
        <button
          className="table-button"
          type="button"
          disabled={props.busy}
          onClick={props.onRequest}
        >
          REMATCH
        </button>
      )}
      <button className="exit-link" type="button" onClick={props.onExit}>
        EXIT
      </button>
      <StatusMessage error={props.error} />
      <WalnutRail />
    </section>
  );
}

function ResultColumn(props: {
  readonly name: string;
  readonly score: number;
  readonly words: readonly string[];
  readonly winner: boolean;
}): React.JSX.Element {
  return (
    <article className="result-column" data-winner={props.winner}>
      <h2>{props.name}</h2>
      <strong className="final-score">{props.score.toLocaleString()}</strong>
      <span className="points">POINTS</span>
      <ul>
        {props.words.map((word) => (
          <li key={word}>
            <span>{word}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}
type CompletedWireResult = NonNullable<
  WireGameStateResponse["results"]
>[number];

export function sixLetterKiwiWords(
  result: Pick<CompletedWireResult, "missedWords"> | undefined,
): readonly string[] {
  return result?.missedWords.filter((word) => word.length === 6) ?? [];
}

function KiwiWordsColumn(props: {
  readonly words: readonly string[];
}): React.JSX.Element {
  return (
    <article className="result-column kiwi-column">
      <h2>KIWI’S 6-LETTER WORDS</h2>
      <span className="kiwi-word-count">{props.words.length} POSSIBLE</span>
      <ul>
        {props.words.map((word) => (
          <li key={word}>
            <span>{word}</span>
            <strong>2000</strong>
          </li>
        ))}
      </ul>
    </article>
  );
}
function WalnutRail(): React.JSX.Element {
  return <div className="walnut-rail" aria-hidden="true" />;
}
function KiwiFruit(props: { readonly className?: string }): React.JSX.Element {
  return (
    <span
      className={`kiwi-mark${props.className ? ` ${props.className}` : ""}`}
      role="img"
      aria-label="Sliced kiwi fruit"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <i key={String(index)} />
      ))}
    </span>
  );
}
function StatusMessage(props: {
  readonly error: string;
}): React.JSX.Element | null {
  return props.error ? (
    <p className="error-message" role="alert">
      {props.error}
    </p>
  ) : null;
}
function remaining(state: WireGameStateResponse): number {
  const expiry = state.me.round?.expiresAt;
  if (!expiry) return 0;
  const offset = Date.parse(state.serverNow) - Date.now();
  return Math.max(
    0,
    Math.ceil((Date.parse(expiry) - (Date.now() + offset)) / 1_000),
  );
}
function replaceLocation(gameId: string): void {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("game", gameId);
  window.history.replaceState({}, "", url);
}
function messageOf(value: unknown): string {
  return value instanceof Error
    ? value.message
    : "Something went wrong. Please try again.";
}
function rejectionMessage(code: string | null): string {
  return (
    (
      {
        EMPTY_WORD: "Enter a word.",
        INVALID_CHARACTERS: "Use letters only.",
        WORD_TOO_SHORT: "Words need at least 3 letters.",
        WORD_TOO_LONG: "That word is too long.",
        WORD_NOT_IN_RACK: "That word does not fit these letters.",
        WORD_NOT_IN_DICTIONARY: "Not in the club dictionary.",
        DUPLICATE_WORD: "You already found that one.",
      } as Record<string, string>
    )[code ?? ""] ?? "That word was not accepted."
  );
}

export function rematchMode(
  state: Pick<WireGameStateResponse, "opponent">,
  selectedMode: GameMode,
): GameMode {
  return state.opponent?.displayName === "Kiwi" ? "solo" : selectedMode;
}
