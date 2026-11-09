import { useState } from "react";
import { useAuth } from "../auth";
import { listPending, reviewApprove, reviewReject } from "../review/demoStore";
import { REJECT_REASONS, type RejectReason } from "../review/types";

export function BlacklistReviewPage() {
  const { user } = useAuth();
  const [tick, setTick] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [reason, setReason] = useState<RejectReason>(REJECT_REASONS[0]);
  const items = listPending();
  void tick;

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
    const r = reviewReject(caseId, user.username, reason);
    setMessage(r.ok ? `已退回（${reason}）` : r.message);
    refresh();
  }

  return (
    <main>
      <h1>黑名單審核</h1>
      {message ? <p role="status">{message}</p> : null}
      <label>
        退回理由
        <select
          data-testid="reject-reason"
          value={reason}
          onChange={(ev) => setReason(ev.target.value as RejectReason)}
        >
          {REJECT_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      {items.length === 0 ? (
        <div data-testid="empty-state" className="card">
          <p>尚無待審黑名單</p>
        </div>
      ) : (
        <ul data-testid="blacklist-pending-list">
          {items.map((item) => (
            <li key={item.case_id} className="card">
              <p>
                {item.ip}（信心 {item.confidence}）
              </p>
              <button
                type="button"
                className="btn btn-primary"
                data-testid={`approve-${item.case_id}`}
                onClick={() => onApprove(item.case_id)}
              >
                核准
              </button>{" "}
              <button
                type="button"
                className="btn"
                data-testid={`reject-${item.case_id}`}
                onClick={() => onReject(item.case_id)}
              >
                退回
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
