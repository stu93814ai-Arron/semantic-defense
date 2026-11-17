import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiGet } from "../api";
import { titleFor } from "../roles";

const UNREACHABLE_MESSAGE = "後端無法連線，請稍後再試";
const EMPTY_HINT = "尚無此案件資料";
const MESSAGE_MAX = 200;

const FACT_LABELS = ["來源", "目的端", "時間窗", "連線數", "間隔", "上傳／下載", "目的變化"] as const;

type View =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "ok" }
  | { kind: "auth"; message: string }
  | { kind: "unreachable" }
  | { kind: "client"; message: string };

function truncateMessage(text: string): string {
  return text.length > MESSAGE_MAX ? text.slice(0, MESSAGE_MAX) : text;
}

function clientView(error: unknown): View {
  const raw = typeof error === "string" && error.length > 0 ? error : "請求失敗";
  return { kind: "client", message: truncateMessage(raw) };
}

function viewFrom(status: number, error?: unknown): View {
  if (status === 401) return { kind: "auth", message: "未登入" };
  if (status === 403) return { kind: "auth", message: "權限不足" };
  if (status === 404) return { kind: "empty" };
  if (status >= 200 && status < 300) return { kind: "ok" };
  if (status >= 400 && status < 500) return clientView(error);
  return { kind: "unreachable" };
}

function caseApiPath(caseId: string): string {
  return `/api/judgments/${encodeURIComponent(caseId)}`;
}

function StatusBanner({ view }: { view: View }) {
  if (view.kind === "loading") return <p>載入中…</p>;
  if (view.kind === "empty") {
    return (
      <div data-testid="empty-state">
        <p>{EMPTY_HINT}</p>
      </div>
    );
  }
  if (view.kind === "auth") return <p role="alert">{view.message}</p>;
  if (view.kind === "unreachable") return <p role="alert">{UNREACHABLE_MESSAGE}</p>;
  if (view.kind === "client") return <p role="alert">{view.message}</p>;
  return null;
}

function FactsCard() {
  return (
    <section className="card case-detail__facts" data-testid="case-facts">
      <h2>連線事實</h2>
      {FACT_LABELS.map((label) => (
        <div className="case-detail__fact" key={label}>
          <div className="case-detail__k">{label}</div>
          <div className="case-detail__v">尚未接線</div>
        </div>
      ))}
    </section>
  );
}

function AiPanel() {
  return (
    <section className="card case-detail__ai" data-testid="case-ai">
      <h2>AI 分析</h2>
      <p>AI 尚未啟用</p>
    </section>
  );
}

export function JudgmentDetailPage() {
  const { caseId } = useParams<{ caseId: string }>();
  const [view, setView] = useState<View>({ kind: "loading" });

  useEffect(() => {
    if (!caseId) {
      setView({ kind: "empty" });
      return;
    }
    let cancelled = false;
    setView({ kind: "loading" });
    void apiGet(caseApiPath(caseId))
      .then((r) => {
        if (!cancelled) setView(viewFrom(r.status, r.error));
      })
      .catch(() => {
        if (!cancelled) setView({ kind: "unreachable" });
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const eyebrow = caseId ? `待判斷 / ${caseId}` : "待判斷";

  return (
    <main className="case-detail">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{titleFor("/judgments/:id")}</h1>
      <StatusBanner view={view} />
      <div className="case-detail__row">
        <FactsCard />
        <AiPanel />
      </div>
    </main>
  );
}
