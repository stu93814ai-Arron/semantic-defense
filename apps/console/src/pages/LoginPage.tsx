import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import type { Role } from "../roles";

function homeFor(role: Role): string {
  if (role === "operator") return "/judgments";
  if (role === "app_owner") return "/apps/new";
  return "/admin/users";
}

/** 結構向登入頁；同步登入後再 client navigate。 */
export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = login(username, password);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    navigate(homeFor(result.role), { replace: true });
  }

  return (
    <main>
      <h1>登入</h1>
      <form onSubmit={onSubmit}>
        <label>
          帳號
          <input
            data-testid="login-username"
            value={username}
            onChange={(ev) => setUsername(ev.target.value)}
            autoComplete="username"
          />
        </label>
        <label>
          密碼
          <input
            data-testid="login-password"
            type="password"
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button data-testid="login-submit" type="submit" disabled={busy}>
          登入
        </button>
      </form>
      {error ? <p data-testid="login-error">{error}</p> : null}
    </main>
  );
}
