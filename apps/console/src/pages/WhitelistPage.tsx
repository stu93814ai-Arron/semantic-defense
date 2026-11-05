import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import {
  listAllowlist,
  reviewAddAllowlist,
  reviewRemoveAllowlist,
} from "../review/demoStore";

export function WhitelistPage() {
  const { user } = useAuth();
  const [cidr, setCidr] = useState("");
  const [reason, setReason] = useState("");
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  void tick;
  const items = listAllowlist();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    const r = reviewAddAllowlist({ cidr, reason }, user.username);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setError(null);
    setCidr("");
    setReason("");
    setTick((n) => n + 1);
  }

  function onRemove(id: string) {
    if (!user) return;
    reviewRemoveAllowlist(id, user.username);
    setTick((n) => n + 1);
  }

  return (
    <main>
      <h1>白名單</h1>
      <form className="card" onSubmit={onSubmit}>
        <label>
          IP 或 CIDR
          <input
            data-testid="whitelist-cidr"
            value={cidr}
            onChange={(ev) => setCidr(ev.target.value)}
          />
        </label>
        <label>
          理由
          <input
            data-testid="whitelist-reason"
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
          />
        </label>
        <button className="btn btn-primary" type="submit" data-testid="whitelist-add">
          新增
        </button>
        {error ? <p data-testid="whitelist-error">{error}</p> : null}
      </form>
      {items.length === 0 ? (
        <div data-testid="empty-state" className="card">
          <p>尚無白名單項目</p>
        </div>
      ) : (
        <ul data-testid="whitelist-list">
          {items.map((item) => (
            <li key={item.entry_id} className="card">
              <p>
                {item.cidr} — {item.reason}
              </p>
              <button
                type="button"
                className="btn"
                data-testid={`whitelist-remove-${item.entry_id}`}
                onClick={() => onRemove(item.entry_id)}
              >
                刪除
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
