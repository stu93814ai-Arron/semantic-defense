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

export function HealthPage() {
  const [body, setBody] = useState<HealthBody | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void apiGet<HealthBody>("/api/health").then((r) => {
      if (cancelled) return;
      setBody(r.data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);
  const alerts = body?.alerts;
  return (
    <main>
      <h1>平台健康</h1>
      {loading && <p>載入中…</p>}
      {!loading && !alerts && <p data-testid="empty-state">尚無健康資料</p>}
      {alerts && (
        <>
        {alerts.undelivered === 0 && alerts.last_failed_at == null && (
          <p data-testid="empty-state">尚無未送達告警</p>
        )}
        <dl data-testid="alert-health">
          <dt>待送達</dt><dd>{alerts.pending}</dd>
          <dt>重試用盡</dt><dd>{alerts.failed}</dd>
          <dt>未送達合計</dt><dd>{alerts.undelivered}</dd>
          <dt>一小時內已送達</dt><dd>{alerts.delivered_1h}</dd>
          <dt>最後失敗時間</dt><dd>{alerts.last_failed_at ?? "無"}</dd>
        </dl>
        </>
      )}
    </main>
  );
}
