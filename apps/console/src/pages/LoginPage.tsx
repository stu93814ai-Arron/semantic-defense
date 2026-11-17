import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import type { Role } from "../roles";

function homeFor(role: Role): string {
  if (role === "operator") return "/judgments";
  if (role === "app_owner") return "/apps/new";
  return "/admin/users";
}

function isExpiredState(state: unknown): boolean {
  return Boolean(state && typeof state === "object" && (state as { expired?: unknown }).expired === true);
}

function LoginBrand() {
  return (
    <section className="login-page__brand" aria-label="應用語意防禦">
      <div className="login-page__brand-top">
        <p className="login-page__product">應用語意防禦</p>
        <p className="eyebrow login-page__on-wood">管理主控台</p>
      </div>
      <div className="login-page__brand-bottom">
        <p className="login-page__tagline">
          安靜地
          <br />
          守護每一次請求
        </p>
        <p className="eyebrow login-page__on-wood">Semantic Defense · Est. 2026</p>
      </div>
    </section>
  );
}

function LoginForm(props: {
  username: string;
  password: string;
  busy: boolean;
  expired: boolean;
  error: string | null;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
}) {
  return (
    <section className="login-page__panel">
      <div className="login-page__form-wrap">
        <p className="eyebrow">Welcome back</p>
        <h1>值勤登入</h1>
        <p className="login-page__lead">請以公司帳號登入。寫入操作將留存稽核紀錄。</p>
        {props.expired ? (
          <p className="login-page__timeout" role="status">
            工作階段已逾時，請重新登入。
          </p>
        ) : null}
        <form onSubmit={props.onSubmit}>
          <label>
            帳號
            <input
              data-testid="login-username"
              value={props.username}
              onChange={(ev) => props.onUsername(ev.target.value)}
              autoComplete="username"
            />
          </label>
          <label>
            密碼
            <input
              data-testid="login-password"
              type="password"
              value={props.password}
              onChange={(ev) => props.onPassword(ev.target.value)}
              autoComplete="current-password"
            />
          </label>
          <button
            className="btn btn-primary login-page__submit"
            data-testid="login-submit"
            type="submit"
            disabled={props.busy}
          >
            登入
          </button>
        </form>
        {props.error ? <p data-testid="login-error">{props.error}</p> : null}
      </div>
    </section>
  );
}

/** 結構向登入頁；同步登入後再 client navigate。 */
export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const expired = isExpiredState(location.state);
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
    <main className="login-page">
      <LoginBrand />
      <LoginForm
        username={username}
        password={password}
        busy={busy}
        expired={expired}
        error={error}
        onUsername={setUsername}
        onPassword={setPassword}
        onSubmit={onSubmit}
      />
    </main>
  );
}
