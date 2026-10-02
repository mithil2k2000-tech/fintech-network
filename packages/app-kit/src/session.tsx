import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { UserDto } from "@fintech-network/shared-types";
import { ApiError, type HttpClient } from "./http.js";

// Signing in, staying signed in, and signing out — the same in every app
// in this network, so it lives here once. Each app calls createSession()
// with its own HTTP client and auth calls, and gets back its own
// provider and hook.
//
// Since Phase 14 the session is an httpOnly cookie set by the API. This
// file therefore holds no token: it can't, and that's the point — a
// script that finds its way onto the page can't read the session
// either. What's left is a question the app asks the server on every
// load: "who am I?" The answer is the session.
//
// The one thing it does keep is a hint: a flag saying "someone signed
// in in this tab". It carries no credential and opens nothing. Without
// it the app couldn't tell an expired session from a first visit — both
// are a 401 — and would either greet a new visitor with "your session
// has ended" or drop a returning one at the sign-in screen with no
// explanation at all.

export type SessionStatus = "loading" | "signed-in" | "signed-out" | "unavailable";

export interface SessionValue {
  status: SessionStatus;
  user: UserDto | null;
  /** Why the user was signed out, if it wasn't their choice. */
  notice: string | null;
  /** Try restoring the session again after a failure that wasn't a 401. */
  retry: () => void;
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  signOut: () => void;
}

export interface SessionAuth {
  login: (email: string, password: string) => Promise<{ user: UserDto }>;
  register: (email: string, password: string) => Promise<{ user: UserDto }>;
  me: () => Promise<{ user: UserDto }>;
  /**
   * Ends the session server-side. The app can't drop the cookie itself
   * — only the server can tell the browser to — so signing out is a
   * request, not a local gesture.
   */
  logout: () => Promise<void>;
}

export interface CreateSessionOptions {
  http: HttpClient;
  auth: SessionAuth;
  /**
   * Where this app keeps its "someone signed in here" flag. Different
   * per app, like the session cookie's own scope, so two apps open in
   * one browser don't answer for each other.
   */
  hintKey: string;
}

export function createSession(options: CreateSessionOptions) {
  const { http, auth, hintKey } = options;

  function hadSession(): boolean {
    try {
      return sessionStorage.getItem(hintKey) === "1";
    } catch {
      // Storage blocked (private mode and so on). The session still
      // works; the person just won't be told why it ended.
      return false;
    }
  }

  function rememberSession(had: boolean) {
    try {
      if (had) sessionStorage.setItem(hintKey, "1");
      else sessionStorage.removeItem(hintKey);
    } catch {
      // As above — nothing here is load-bearing.
    }
  }

  const ENDED = "Your session has ended. Please sign in again.";
  const SessionContext = createContext<SessionValue | null>(null);

  function SessionProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<UserDto | null>(null);
    // Nothing here can tell whether there's a session without asking, so
    // every load starts by asking.
    const [status, setStatus] = useState<SessionStatus>("loading");
    const [notice, setNotice] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);

    const clear = useCallback((message: string | null) => {
      rememberSession(false);
      setUser(null);
      setStatus("signed-out");
      setNotice(message);
    }, []);

    // A 401 in the middle of using the app is always a session that
    // ended, so this one always explains itself.
    useEffect(() => {
      http.configure({ onUnauthorized: () => clear(ENDED) });
    }, [clear]);

    // Restore a session after a refresh — or find out there isn't one.
    useEffect(() => {
      let cancelled = false;
      // Read the hint before asking, not after: the client's own
      // unauthorized hook clears it on the way through, so by the time
      // the catch below runs it would always say "first visit".
      const had = hadSession();
      setStatus("loading");
      auth
        .me()
        .then(({ user }) => {
          if (cancelled) return;
          rememberSession(true);
          setUser(user);
          setNotice(null);
          setStatus("signed-in");
        })
        .catch((err) => {
          if (cancelled) return;
          // A 401 means there's no session. Whether that deserves an
          // explanation depends on whether there was one: a returning
          // person whose session expired is told, a first-time visitor
          // is just shown the sign-in screen. Anything else (offline, a
          // rate limit, a blip) must NOT be read as signed-out — it's a
          // failure to find out.
          if (err instanceof ApiError && err.status === 401) {
            clear(had ? ENDED : null);
            return;
          }
          setStatus("unavailable");
        });
      return () => {
        cancelled = true;
      };
    }, [clear, attempt]);

    const accept = useCallback((u: UserDto) => {
      rememberSession(true);
      setUser(u);
      setNotice(null);
      setStatus("signed-in");
    }, []);

    const value = useMemo<SessionValue>(
      () => ({
        status,
        user,
        notice,
        signIn: async (email, password) => {
          const { user } = await auth.login(email, password);
          accept(user);
        },
        register: async (email, password) => {
          const { user } = await auth.register(email, password);
          accept(user);
        },
        signOut: () => {
          // Clear the screen straight away; the cookie goes when the
          // server answers. If that request fails the session is ended
          // here regardless — the cookie expires on its own, and a
          // sign-out that appears not to work is worse.
          clear(null);
          void auth.logout().catch(() => undefined);
        },
        retry: () => setAttempt((n) => n + 1),
      }),
      [status, user, notice, accept, clear]
    );

    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
  }

  function useSession(): SessionValue {
    const value = useContext(SessionContext);
    if (!value) throw new Error("useSession must be used inside SessionProvider");
    return value;
  }

  return { SessionProvider, useSession };
}
