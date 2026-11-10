import { useEffect, useState } from "react";
import { apiGet } from "../api";

/** 告警計數（對齊 control-api GET /api/health）。版面尚待 B 組領航員核准。 */
export type AlertHealthView = {
  pending: number;
  failed: number;
  delivered_1h: number;
  undelivered: number;
  last_failed_at: number | null;
};

export type HealthBody = { status: string; alerts?: AlertHealthView };

const FAILED_AT_FMT = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  dateStyle: "medium",
  timeStyle: "medium",
});

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function hasCountFields(o: Record<string, unknown>): boolean {
  return isFiniteNumber(o.pending) && isFiniteNumber(o.failed)
    && isFiniteNumber(o.delivered_1h) && isFiniteNumber(o.undelivered);
}

function hasOptionalFields(o: Record<string, unknown>): boolean {
  if (o.last_failed_at !== null && !isFiniteNumber(o.last_failed_at)) return false;
  if ("purged" in o && o.purged !== undefined && !isFiniteNumber(o.purged)) return false;
  return true;
}

/** 簡單型別守衛：計數欄位必須是有限數字；last_failed_at 為數字或 null。 */
export function isAlertHealthView(v: unknown): v is AlertHealthView {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return hasCountFields(o) && hasOptionalFields(o);
}

function formatFailedAt(at: number): string {
  return FAILED_AT_FMT.format(new Date(at));
}

type HealthView =
  | { kind: "loading" }
  | { kind: "connect-error" }
  | { kind: "auth-error"; message: string }
  | { kind: "format-error" }
  | { kind: "empty-data" }
  | { kind: "alerts"; alerts: AlertHealthView };

function viewFromResult(status: number, data: HealthBody | null): HealthView {
  // 401／403 用語：A 組領航員裁示（未經使用者確認）；須 B 組領航員核准。
  if (status === 401) return { kind: "auth-error", message: "未登入" };
  if (status === 403) return { kind: "auth-error", message: "權限不足" };
  if (status !== 200) return { kind: "connect-error" };
  if (!data || data.alerts === undefined) return { kind: "empty-data" };
  if (!isAlertHealthView(data.alerts)) return { kind: "format-error" };
  return { kind: "alerts", alerts: data.alerts };
}

function HealthStatus({ view }: { view: HealthView }) {
  if (view.kind === "loading") return <p>載入中…</p>;
  if (view.kind === "connect-error") {
    return (
      <div data-testid="backend-unreachable" className="card" role="alert">
        <p>後端無法連線，請稍後再試</p>
      </div>
    );
  }
  if (view.kind === "auth-error") {
    return (
      <div data-testid="auth-error" className="card" role="alert">
        <p>{view.message}</p>
      </div>
    );
  }
  if (view.kind === "format-error") {
    return (
      <div data-testid="invalid-response" className="card" role="alert">
        <p>回應格式不符契約</p>
      </div>
    );
  }
  if (view.kind === "empty-data") return <p data-testid="empty-state">尚無健康資料</p>;
  return null;
}

function AlertCounts({ alerts }: { alerts: AlertHealthView }) {
  return (
    <>
      {alerts.undelivered === 0 && alerts.last_failed_at == null && (
        <p data-testid="empty-state">尚無未送達告警</p>
      )}
      <dl data-testid="alert-health">
        <dt>待送達</dt><dd>{alerts.pending}</dd>
        <dt>重試用盡</dt><dd>{alerts.failed}</dd>
        <dt>未送達合計</dt><dd>{alerts.undelivered}</dd>
        <dt>一小時內已送達</dt><dd>{alerts.delivered_1h}</dd>
        <dt>最後失敗時間</dt><dd>{alerts.last_failed_at != null ? formatFailedAt(alerts.last_failed_at) : "無"}</dd>
      </dl>
    </>
  );
}

export function HealthPage() {
  const [view, setView] = useState<HealthView>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    void apiGet<HealthBody>("/api/health")
      .then((r) => { if (!cancelled) setView(viewFromResult(r.status, r.data)); })
      .catch(() => { if (!cancelled) setView({ kind: "connect-error" }); });
    return () => { cancelled = true; };
  }, []);
  return (
    <main>
      <h1>平台健康</h1>
      <HealthStatus view={view} />
      {view.kind === "alerts" && <AlertCounts alerts={view.alerts} />}
    </main>
  );
}
