import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import { accessFor, isAppMapPath, titleFor } from "./roles";
import { EmptyDataPage } from "./pages/EmptyDataPage";
import { LoginPage } from "./pages/LoginPage";
import { NoPermissionPage } from "./pages/NoPermissionPage";
import { apiGet } from "./api";

function probeUrl(path: string): string | null {
  if (path === "/judgments" || path === "/judgments/history") return "/api/judgments";
  if (/^\/judgments\/[^/]+$/.test(path)) return `/api/judgments/${path.slice("/judgments/".length)}`;
  if (path === "/constraints") return "/api/constraints";
  if (path === "/admin/users") return "/api/admin/users";
  if (path === "/audit") return "/api/audit";
  if (path === "/versions") return "/api/versions";
  if (path === "/health") return "/api/health";
  if (path === "/apps/new") return null;
  const m = /^\/apps\/([^/]+)\/map$/.exec(path);
  if (m) return `/api/apps/${m[1]}/map`;
  return null;
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
      if (r.status === 401) return;
      if (r.status === 403) {
        setApiGate("deny");
        return;
      }
      // 應用地圖：非己應用為 404 → 無權限；案件 404 仍顯示空狀態
      if (r.status === 404 && isAppMapPath(location.pathname)) {
        setApiGate("deny");
        return;
      }
      setApiGate("ok");
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

export function App() {
  return (
    <div data-testid="app-shell">
      <Routes>
        <Route path="/login" element={<LoginPage />} />
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
      </Routes>
    </div>
  );
}
