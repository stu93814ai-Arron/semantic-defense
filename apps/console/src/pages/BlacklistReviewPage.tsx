import { useState } from "react";
import { useAuth } from "../auth";
import { listPending, reviewApprove, reviewReject } from "../review/demoStore";

export function BlacklistReviewPage() {
  const { user } = useAuth();
  const [tick, setTick] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const items = listPending();
  void tick;

  function refresh() {
    setTick((n) => n + 1);
  }

  function onApprove(id: string) {
    if (!user) return;
    const r = reviewApprove(id, user.username);
    setMessage(r.ok ? "已核准" : r.message);
    refresh();
  }

  function onReject(id: string) {
    if (!user) return;
    const r = reviewReject(id, user.username);
    setMessage(r.ok ? "已退回" : r.message);
    refresh();
  }

  return (
    <main>
      <h1>黑名單審核</h1>
      {message ? <p role="status">{message}</p> : null}
      {items.length === 0 ? (
        <div data-testid="empty-state" className="card">
          <p>尚無待審黑名單</p>
        </div>
      ) : (
        <ul data-testid="blacklist-pending-list">
          {items.map((item) => (
            <li key={item.candidate_id} className="card">
              <p>
                {item.ip}（信心 {item.confidence}）
              </p>
              <button
                type="button"
                className="btn btn-primary"
                data-testid={`approve-${item.candidate_id}`}
                onClick={() => onApprove(item.candidate_id)}
              >
                核准
              </button>{" "}
              <button
                type="button"
                className="btn"
                data-testid={`reject-${item.candidate_id}`}
                onClick={() => onReject(item.candidate_id)}
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
