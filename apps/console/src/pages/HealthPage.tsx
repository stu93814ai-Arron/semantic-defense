import { useEffect, useState, type ReactNode } from "react";
import { apiGet } from "../api";
import { titleFor } from "../roles";

/** 告警計數（對齊 control-api GET /api/health）。 */
export type AlertHealthView = {
  pending: number;
  failed: number;
  delivered_1h: number;
  undelivered: number;
  last_failed_at: number | null;
};

/** 判定程序計數（GET /api/health 的可選 judge）。 */
export type JudgeHealthView = {
  tick_fail_streak: number;
  cursor_lag_seconds: number;
  stale_pending_total: number;
};

export type HealthBody = {
  status: string;
  alerts?: AlertHealthView;
  judge?: JudgeHealthView;
};

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

export function isJudgeHealthView(v: unknown): v is JudgeHealthView {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return isFiniteNumber(o.tick_fail_streak)
    && isFiniteNumber(o.cursor_lag_seconds)
    && isFiniteNumber(o.stale_pending_total);
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
  | { kind: "alerts"; alerts: AlertHealthView; status: unknown; judge?: JudgeHealthView };

function viewFromResult(status: number, data: HealthBody | null): HealthView {
  // 401／403 用語：A 組已修；保持「未登入」「權限不足」。
  if (status === 401) return { kind: "auth-error", message: "未登入" };
  if (status === 403) return { kind: "auth-error", message: "權限不足" };
  if (status !== 200) return { kind: "connect-error" };
  if (!data || data.alerts === undefined) return { kind: "empty-data" };
  if (!isAlertHealthView(data.alerts)) return { kind: "format-error" };
  return {
    kind: "alerts",
    alerts: data.alerts,
    status: data.status,
    judge: isJudgeHealthView(data.judge) ? data.judge : undefined,
  };
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
        <dt>最後失敗時間</dt>
        <dd>{alerts.last_failed_at != null ? formatFailedAt(alerts.last_failed_at) : "無"}</dd>
      </dl>
    </>
  );
}

function StatusCard(props: { title: string; children: ReactNode }) {
  return (
    <div className="card health-status-card">
      <div className="health-status-card__label">{props.title}</div>
      <div>{props.children}</div>
    </div>
  );
}

function JudgeCard({ judge }: { judge?: JudgeHealthView }) {
  return (
    <StatusCard title="判定程序">
      {judge ? (
        <ul>
          <li>連續失敗 {judge.tick_fail_streak}</li>
          <li>游標落後 {judge.cursor_lag_seconds} 秒</li>
          <li>過期待審 {judge.stale_pending_total}</li>
        </ul>
      ) : (
        "尚未接線"
      )}
    </StatusCard>
  );
}

const CONTROL_STATUS_MAX = 32;

/** 僅短字串 status 會出現在括號內，避免物件進入 React 子節點。 */
function controlApiText(status: unknown): string {
  if (typeof status === "string" && status.length > 0 && status.length <= CONTROL_STATUS_MAX) {
    return `健康端點可連線（${status}）`;
  }
  return "健康端點可連線";
}

function StatusGrid(props: { judge?: JudgeHealthView; apiStatus: unknown }) {
  return (
    <div className="health-status-grid" data-testid="health-status-grid">
      <StatusCard title="鏡像接收">尚未接線</StatusCard>
      <JudgeCard judge={props.judge} />
      <StatusCard title="模型連線">AI 尚未啟用</StatusCard>
      <StatusCard title="EDL 發布">尚未接線</StatusCard>
      <StatusCard title="控制 API">{controlApiText(props.apiStatus)}</StatusCard>
      <StatusCard title="資料庫">尚未接線</StatusCard>
      <StatusCard title="簽章金鑰">尚未接線</StatusCard>
      <StatusCard title="運作模式">尚未接線</StatusCard>
    </div>
  );
}

function AlertFeedPlaceholder() {
  return (
    <section className="card" data-testid="health-alert-feed">
      <h2>告警清單</h2>
      <p>尚未接線</p>
    </section>
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
      <p className="eyebrow">系統 / 狀態</p>
      <h1>{titleFor("/health")}</h1>
      <HealthStatus view={view} />
      {view.kind === "alerts" && (
        <>
          {view.alerts.undelivered > 0 ? <p role="status">未送達</p> : null}
          <StatusGrid judge={view.judge} apiStatus={view.status} />
          <AlertCounts alerts={view.alerts} />
          <AlertFeedPlaceholder />
        </>
      )}
    </main>
  );
}
