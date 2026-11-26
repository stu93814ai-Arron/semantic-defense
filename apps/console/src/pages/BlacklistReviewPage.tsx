import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { isPendingExpired } from "../review/demoStore";
import { formatPendingHits } from "../review/pendingHits";
import { reviewSource } from "../review/reviewSource";
import type { PendingCandidate } from "../review/types";
import { DemoDataMarker } from "../review/DemoDataMarker";

const CREATED_FMT = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatCreatedAt(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? CREATED_FMT.format(ms) : iso;
}

function PendingRow(props: {
  item: PendingCandidate;
  now: string;
  busy: boolean;
  onApprove: (caseId: string) => void;
  onReject: (caseId: string) => void;
}) {
  const { item, now, busy, onApprove, onReject } = props;
  const expired = isPendingExpired(item, now);
  return (
    <tr>
      <td className="mono">{item.case_id}</td>
      <td className="mono">{formatCreatedAt(item.created_at)}</td>
      <td>
        <span className="mono">{item.ip}</span>
        <p data-testid={`hits-${item.case_id}`}>{formatPendingHits(item)}</p>
      </td>
      <td>尚未接線</td>
      <td data-testid={`ai-reason-${item.case_id}`}>AI 尚未啟用</td>
      <td className="mono">{item.confidence}</td>
      <td>核准後封鎖 24 小時</td>
      <td className="review-actions">
        {expired ? (
          <p data-testid={`expired-${item.case_id}`} role="status">
            already_expired：此項目已到期
          </p>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          data-testid={`approve-${item.case_id}`}
          onClick={() => onApprove(item.case_id)}
          disabled={expired || busy}
        >
          核准
        </button>{" "}
        <button
          type="button"
          className="btn"
          data-testid={`reject-${item.case_id}`}
          onClick={() => onReject(item.case_id)}
          disabled={expired || busy}
        >
          駁回
        </button>
      </td>
    </tr>
  );
}

export function BlacklistReviewPage({ nowIso }: { nowIso?: string } = {}) {
  const { user } = useAuth();
  const [tick, setTick] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [items, setItems] = useState<PendingCandidate[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const unreachable = reviewSource.isUnreachable();
  const now = nowIso ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  useEffect(() => {
    let cancelled = false;
    void reviewSource.listPending().then((pending) => {
      if (cancelled) return;
      setItems(pending.ok ? pending.value : []);
      if (!pending.ok) setMessage(pending.message);
    });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  function refresh() {
    setTick((n) => n + 1);
  }

  async function runDecision(
    caseId: string,
    act: (id: string) => Promise<{ ok: true } | { ok: false; message: string }>,
    okText: string,
  ) {
    if (!user) return;
    setBusyId(caseId);
    try {
      const r = await act(caseId);
      setMessage(r.ok ? okText : r.message);
      refresh();
    } finally {
      setBusyId(null);
    }
  }

  function onApprove(caseId: string) {
    void runDecision(caseId, (id) => reviewSource.approve(id), "已核准");
  }

  function onReject(caseId: string) {
    void runDecision(caseId, (id) => reviewSource.reject(id), "已退回");
  }

  return (
    <main>
      <h1>黑名單審核</h1>
      <DemoDataMarker />
      <p className="review-banner card">
        <b>{items.length} 件待審</b>
        <span>信心範圍尚未接線。</span>
        <span data-testid="review-ai-status">AI 尚未啟用</span>
      </p>
      <ReviewAlerts message={message} unreachable={unreachable} empty={items.length === 0} />
      <PendingList
        items={items}
        hidden={unreachable}
        now={now}
        busyId={busyId}
        onApprove={onApprove}
        onReject={onReject}
      />
    </main>
  );
}


function ReviewAlerts(props: {
  message: string | null;
  unreachable: boolean;
  empty: boolean;
}) {
  return (
    <>
      {props.message ? (
        <p role="status" data-testid="review-status">
          {props.message}
        </p>
      ) : null}
      {props.unreachable ? (
        <div data-testid="backend-unreachable" className="card" role="alert">
          <p>後端無法連線，請稍後再試</p>
        </div>
      ) : null}
      {!props.unreachable && props.empty ? (
        <div data-testid="empty-state" className="card">
          <p>尚無待審黑名單</p>
        </div>
      ) : null}
    </>
  );
}

function PendingList(props: {
  items: PendingCandidate[];
  hidden: boolean;
  now: string;
  busyId: string | null;
  onApprove: (caseId: string) => void;
  onReject: (caseId: string) => void;
}) {
  if (props.hidden || props.items.length === 0) return null;
  return (
    <section className="card review-queue">
      <h2>待審佇列</h2>
      <div className="review-table-wrap">
        <table data-testid="blacklist-pending-list" className="review-table">
          <thead>
            <tr>
              <th>案件</th>
              <th>成案</th>
              <th>來源</th>
              <th>目的端</th>
              <th>手法與 AI 理由</th>
              <th>信心</th>
              <th>期間</th>
              <th>動作</th>
            </tr>
          </thead>
          <tbody>
            {props.items.map((row) => (
              <PendingRow
                key={row.case_id}
                item={row}
                now={props.now}
                busy={props.busyId === row.case_id}
                onApprove={props.onApprove}
                onReject={props.onReject}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
