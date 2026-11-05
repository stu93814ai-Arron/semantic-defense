import { useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import { accessFor, isAppMapPath, titleFor } from "./roles";
import { EmptyDataPage } from "./pages/EmptyDataPage";
import { LoginPage } from "./pages/LoginPage";
import { NoPermissionPage } from "./pages/NoPermissionPage";
import { ThemeSwitch } from "./theme/ThemeSwitch";
import { apiGet } from "./api";

function probeExact(path: string): string | null {
  if (path === "/judgments" || path === "/judgments/history") return "/api/judgments";
  if (path === "/constraints") return "/api/constraints";
  if (path === "/admin/users") return "/api/admin/users";
  if (path === "/audit") return "/api/audit";
  if (path === "/versions") return "/api/versions";
  if (path === "/health") return "/api/health";
  return null;
}

function probeUrl(path: string): string | null {
  if (path === "/apps/new") return null;
  const exact = probeExact(path);
  if (exact) return exact;
  if (/^\/judgments\/[^/]+$/.test(path)) {
    return `/api/judgments/${path.slice("/judgments/".length)}`;
  }
  const m = /^\/apps\/([^/]+)\/map$/.exec(path);
  return m ? `/api/apps/${m[1]}/map` : null;
}

function decideApiGate(status: number, path: string): "ok" | "deny" | "ignore" {
  if (status === 401) return "ignore";
  if (status === 403) return "deny";
  if (status === 404 && isAppMapPath(path)) return "deny";
  return "ok";
}

function ProtectedEmpty({ hint }: { hint: string }) {
  const { user, ready, refresh } = useAuth();
  const location = useLocation();
  const roleGate = ready ? accessFor(location.pathname, user) : "loading";
  const [apiGate, setApiGate] = useState<"pending" | "ok" | "deny">("pending");

  useEffect(() => {
    void refresh();
  }, [location.pathname, refresh]);

  useEffect(() => {
    if (roleGate !== "ok") {
      setApiGate("pending");
      return;
    }
    const url = probeUrl(location.pathname);
    if (!url) {
      setApiGate("ok");
      return;
    }
    let cancelled = false;
    setApiGate("pending");
    void apiGet(url).then((r) => {
      if (cancelled) return;
      const next = decideApiGate(r.status, location.pathname);
      if (next !== "ignore") setApiGate(next);
    });
    return () => {
      cancelled = true;
    };
  }, [roleGate, location.pathname]);

  if (roleGate === "loading" || (roleGate === "ok" && apiGate === "pending")) {
    return <main>載入中…</main>;
  }
  if (roleGate === "login") {
    return (
      <>
        <main>請先登入</main>
        <Navigate to="/login" replace />
      </>
    );
  }
  if (roleGate === "deny" || apiGate === "deny") return <NoPermissionPage />;
  return <EmptyDataPage title={titleFor(location.pathname)} hint={hint} />;
}

function AppChrome() {
  return (
    <div className="app-chrome">
      <aside className="app-sidebar" data-testid="theme-slot-sidebar">
        <ThemeSwitch />
      </aside>
      <div className="app-chrome__main">
        <header className="app-topbar" data-testid="theme-slot-topbar">
          <ThemeSwitch />
        </header>
        <Outlet />
      </div>
    </div>
  );
}

function LoginRoute() {
  return (
    <>
      <div className="theme-slot-login" data-testid="theme-slot-login">
        <ThemeSwitch />
      </div>
      <LoginPage />
    </>
  );
}

export function App() {
  return (
    <div data-testid="app-shell">
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        <Route element={<AppChrome />}>
          <Route path="/admin/users" element={<ProtectedEmpty hint="尚無人員資料" />} />
          <Route path="/apps/new" element={<ProtectedEmpty hint="尚無已接入應用" />} />
          <Route path="/apps/:appId/map" element={<ProtectedEmpty hint="尚無地圖資料" />} />
          <Route path="/judgments" element={<ProtectedEmpty hint="尚無待判斷案件" />} />
          <Route path="/judgments/history" element={<ProtectedEmpty hint="尚無判斷紀錄" />} />
          <Route path="/judgments/:caseId" element={<ProtectedEmpty hint="尚無此案件資料" />} />
          <Route path="/constraints" element={<ProtectedEmpty hint="尚無生效限制" />} />
          <Route path="/audit" element={<ProtectedEmpty hint="尚無稽核紀錄" />} />
          <Route path="/versions" element={<ProtectedEmpty hint="尚無版本資料" />} />
          <Route path="/health" element={<ProtectedEmpty hint="尚無健康資料" />} />
          <Route path="*" element={<NoPermissionPage />} />
        </Route>
      </Routes>
    </div>
  );
}
