import { useState } from "react";
import { useAuth } from "../auth";
import {
  getThresholds,
  isBackendUnreachable,
  isPendingExpired,
  listPending,
  reviewApprove,
  reviewReject,
} from "../review/demoStore";
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
  const [reasons, setReasons] = useState<Map<string, RejectReason>>(
    () => new Map(),
  );
  void tick;

  const unreachable = isBackendUnreachable();
  const items = listPending();
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  function refresh() {
    setTick((n) => n + 1);
  }

  function onApprove(caseId: string) {
    if (!user) return;
    const r = reviewApprove(caseId, user.username);
    setMessage(r.ok ? "已核准" : r.message);
    refresh();
  }

  function onReject(caseId: string) {
    if (!user) return;
    const reason = reasonFor(reasons, caseId);
    const r = reviewReject(caseId, user.username, reason);
    setMessage(r.ok ? `已退回（${reason}）` : r.message);
    refresh();
  }

  function onReason(caseId: string, reason: RejectReason) {
    setReasons((prev) => new Map(prev).set(caseId, reason));
  }

  const thresholds = getThresholds();

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
      {!unreachable && items.length > 0 ? (
        <ul data-testid="blacklist-pending-list">
          {items.map((item) => (
            <PendingRow
              key={item.case_id}
              item={item}
              now={now}
              reason={reasonFor(reasons, item.case_id)}
              onReason={onReason}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        </ul>
      ) : null}
    </main>
  );
}
