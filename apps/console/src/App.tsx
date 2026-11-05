import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import { accessFor, titleFor } from "./roles";
import { EmptyDataPage } from "./pages/EmptyDataPage";
import { LoginPage } from "./pages/LoginPage";
import { NoPermissionPage } from "./pages/NoPermissionPage";
import { apiGet } from "./api";

function ProtectedEmpty({ hint }: { hint: string }) {
  const { user, ready, refresh } = useAuth();
  const location = useLocation();
  const gate = ready ? accessFor(location.pathname, user) : "loading";

  useEffect(() => {
    void refresh();
  }, [location.pathname, refresh]);

  useEffect(() => {
    if (gate !== "ok") return;
    const path = location.pathname;
    if (path.startsWith("/judgments")) void apiGet("/api/judgments");
    else if (path === "/constraints") void apiGet("/api/constraints");
    else if (path === "/admin/users") void apiGet("/api/admin/users");
    else if (path === "/audit") void apiGet("/api/audit");
    else if (path === "/versions") void apiGet("/api/versions");
    else if (path === "/health") void apiGet("/api/health");
    else if (path === "/apps/new") void apiGet("/api/session/me");
    else {
      const m = /^\/apps\/([^/]+)\/map$/.exec(path);
      if (m) void apiGet(`/api/apps/${m[1]}/map`);
    }
  }, [gate, location.pathname]);

  if (gate === "loading") return <main>載入中…</main>;
  // Navigate 本身不渲染文字；先放提示避免 body 空字串競態
  if (gate === "login") {
    return (
      <>
        <main>請先登入</main>
        <Navigate to="/login" replace />
      </>
    );
  }
  if (gate === "deny") return <NoPermissionPage />;
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
