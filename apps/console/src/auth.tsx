import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  fetchMe,
  loginRequestSync,
  logoutRequest,
  setUnauthorizedHandler,
} from "./api";
import type { SessionUser } from "./roles";

function readHint(): SessionUser | null {
  const match = document.cookie.match(/(?:^|; )sd_hint=([^;]*)/);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(decodeURIComponent(match[1])) as SessionUser;
  } catch {
    return null;
  }
}

type LoginOutcome =
  | { ok: true; role: SessionUser["role"] }
  | { ok: false; message: string };

type AuthState = {
  user: SessionUser | null;
  ready: boolean;
  login: (username: string, password: string) => LoginOutcome;
  logout: () => Promise<void>;
  refresh: () => Promise<SessionUser | null>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(() => readHint());
  const navigate = useNavigate();

  const clearToLogin = useCallback(() => {
    setUser(null);
    navigate("/login", { replace: true });
  }, [navigate]);

  useEffect(() => {
    setUnauthorizedHandler(clearToLogin);
    return () => setUnauthorizedHandler(null);
  }, [clearToLogin]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const me = await fetchMe();
      if (!cancelled) setUser(me);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback((username: string, password: string): LoginOutcome => {
    const result = loginRequestSync(username, password);
    if (!result.ok) return { ok: false, message: result.message };
    setUser(result.user);
    return { ok: true, role: result.user.role };
  }, []);

  const logout = useCallback(async () => {
    await logoutRequest();
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    const me = await fetchMe();
    setUser(me);
    return me;
  }, []);

  const value = useMemo(
    () => ({ user, ready: true, login, logout, refresh }),
    [user, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 須在 AuthProvider 內");
  return ctx;
}
