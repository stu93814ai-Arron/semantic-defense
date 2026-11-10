import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { isPendingExpired } from "../review/demoStore";
import { formatPendingHits } from "../review/pendingHits";
import { reviewSource } from "../review/reviewSource";
import { DEFAULT_THRESHOLDS } from "../review/thresholds";
import { ThresholdReadonly } from "../review/ThresholdReadonly";
import {
  REJECT_REASONS,
  type PendingCandidate,
  type RejectReason,
} from "../review/types";

function reasonFor(
  map: ReadonlyMap<string, RejectReason>,
  caseId: string,
): RejectReason {
  return map.get(caseId) ?? REJECT_REASONS[0];
}

function PendingRow(props: {
  item: PendingCandidate;
  now: string;
  reason: RejectReason;
  onReason: (caseId: string, reason: RejectReason) => void;
  onApprove: (caseId: string) => void;
  onReject: (caseId: string) => void;
}) {
  const { item, now, reason, onReason, onApprove, onReject } = props;
  const expired = isPendingExpired(item, now);
  return (
    <li className="card">
      <p>
        {item.ip}（信心 {item.confidence}）
      </p>
      <p data-testid={`hits-${item.case_id}`}>{formatPendingHits(item)}</p>
      {expired ? (
        <p data-testid={`expired-${item.case_id}`} role="status">
          already_expired：此項目已到期
        </p>
      ) : null}
      <label>
        退回理由
        <select
          data-testid={`reject-reason-${item.case_id}`}
          value={reason}
          onChange={(ev) => onReason(item.case_id, ev.target.value as RejectReason)}
          disabled={expired}
        >
          {REJECT_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>{" "}
      <button
        type="button"
        className="btn btn-primary"
        data-testid={`approve-${item.case_id}`}
        onClick={() => onApprove(item.case_id)}
        disabled={expired}
      >
        核准
      </button>{" "}
      <button
        type="button"
        className="btn"
        data-testid={`reject-${item.case_id}`}
        onClick={() => onReject(item.case_id)}
        disabled={expired}
      >
        退回
      </button>
    </li>
  );
}

export function BlacklistReviewPage() {
  const { user } = useAuth();
  const [tick, setTick] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [items, setItems] = useState<PendingCandidate[]>([]);
  const [thresholds, setThresholds] = useState(DEFAULT_THRESHOLDS);
  const [reasons, setReasons] = useState<Map<string, RejectReason>>(() => new Map());
  const unreachable = reviewSource.isUnreachable();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [pending, th] = await Promise.all([
        reviewSource.listPending(),
        reviewSource.getThresholds(),
      ]);
      if (cancelled) return;
      setItems(pending);
      if (th.ok) setThresholds(th.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  function refresh() {
    setTick((n) => n + 1);
  }

  async function onApprove(caseId: string) {
    if (!user) return;
    const r = await reviewSource.approve(caseId, user.username);
    setMessage(r.ok ? "已核准" : r.message);
    refresh();
  }

  async function onReject(caseId: string) {
    if (!user) return;
    const reason = reasonFor(reasons, caseId);
    const r = await reviewSource.reject(caseId, user.username, reason);
    setMessage(r.ok ? `已退回（${reason}）` : r.message);
    refresh();
  }

  return (
    <main>
      <h1>黑名單審核</h1>
      <ThresholdReadonly value={thresholds} />
      {message ? (
        <p role="status" data-testid="review-status">
          {message}
        </p>
      ) : null}
      {unreachable ? (
        <div data-testid="backend-unreachable" className="card" role="alert">
          <p>後端無法連線，請稍後再試</p>
        </div>
      ) : null}
      {!unreachable && items.length === 0 ? (
        <div data-testid="empty-state" className="card">
          <p>尚無待審黑名單</p>
        </div>
      ) : null}
      <PendingList
        items={items}
        hidden={unreachable}
        now={now}
        reasons={reasons}
        onReason={(caseId, reason) =>
          setReasons((prev) => new Map(prev).set(caseId, reason))
        }
        onApprove={(id) => void onApprove(id)}
        onReject={(id) => void onReject(id)}
      />
    </main>
  );
}

function PendingList(props: {
  items: PendingCandidate[];
  hidden: boolean;
  now: string;
  reasons: ReadonlyMap<string, RejectReason>;
  onReason: (caseId: string, reason: RejectReason) => void;
  onApprove: (caseId: string) => void;
  onReject: (caseId: string) => void;
}) {
  if (props.hidden || props.items.length === 0) return null;
  return (
    <ul data-testid="blacklist-pending-list">
      {props.items.map((item) => (
        <PendingRow
          key={item.case_id}
          item={item}
          now={props.now}
          reason={reasonFor(props.reasons, item.case_id)}
          onReason={props.onReason}
          onApprove={props.onApprove}
          onReject={props.onReject}
        />
      ))}
    </ul>
  );
}
