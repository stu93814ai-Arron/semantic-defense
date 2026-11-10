import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { reviewSource } from "../review/reviewSource";
import type { AllowlistItem } from "../review/types";
import { WhitelistThresholdSection } from "../review/WhitelistThresholdSection";

export function WhitelistPage() {
  const { user } = useAuth();
  const [cidr, setCidr] = useState("");
  const [reason, setReason] = useState("");
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<AllowlistItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void reviewSource.listWhitelist().then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setItems(r.value);
        setError(null);
      } else {
        setItems([]);
        setError(r.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  function refresh() {
    setTick((n) => n + 1);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    const r = await reviewSource.createWhitelist(
      { cidr, reason, expires_at: null },
      user.username,
    );
    if (!r.ok) {
      setError(r.message ?? "新增失敗");
      return;
    }
    setError(null);
    setCidr("");
    setReason("");
    refresh();
  }

  return (
    <main>
      <h1>白名單</h1>
      <WhitelistThresholdSection
        actorId={user?.username}
        onChanged={refresh}
      />
      <AllowlistForm
        cidr={cidr}
        reason={reason}
        error={error}
        onCidr={setCidr}
        onReason={setReason}
        onSubmit={(e) => void onSubmit(e)}
      />
      <AllowlistList
        items={items}
        actorId={user?.username}
        onChanged={refresh}
      />
    </main>
  );
}

function AllowlistForm(props: {
  cidr: string;
  reason: string;
  error: string | null;
  onCidr: (v: string) => void;
  onReason: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
}) {
  const { cidr, reason, error, onCidr, onReason, onSubmit } = props;
  return (
    <form className="card" noValidate onSubmit={onSubmit}>
      <label>
        IP 或 CIDR
        <input
          data-testid="whitelist-cidr"
          value={cidr}
          onChange={(ev) => onCidr(ev.target.value)}
        />
      </label>
      <label>
        理由
        <input
          data-testid="whitelist-reason"
          value={reason}
          onChange={(ev) => onReason(ev.target.value)}
        />
      </label>
      <button className="btn btn-primary" type="submit" data-testid="whitelist-add">
        新增
      </button>
      {error ? <p data-testid="whitelist-error">{error}</p> : null}
    </form>
  );
}

function AllowlistList(props: {
  items: AllowlistItem[];
  actorId: string | undefined;
  onChanged: () => void;
}) {
  const { items, actorId, onChanged } = props;
  if (items.length === 0) {
    return (
      <div data-testid="empty-state" className="card">
        <p>尚無白名單項目</p>
      </div>
    );
  }
  return (
    <ul data-testid="whitelist-list">
      {items.map((item) => (
        <AllowlistRow
          key={item.entry_id}
          item={item}
          actorId={actorId}
          onChanged={onChanged}
        />
      ))}
    </ul>
  );
}

function AllowlistRow(props: {
  item: AllowlistItem;
  actorId: string | undefined;
  onChanged: () => void;
}) {
  const { item, actorId, onChanged } = props;
  const [reason, setReason] = useState(item.reason);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReason(item.reason);
  }, [item.reason]);

  async function onUpdate(e: FormEvent) {
    e.preventDefault();
    if (!actorId) return;
    const r = await reviewSource.updateWhitelist(
      item.entry_id,
      { reason, expires_at: item.expires_at },
      actorId,
    );
    if (!r.ok) {
      setError(r.message ?? "更新失敗");
      return;
    }
    setError(null);
    onChanged();
  }

  async function onRemove() {
    if (!actorId) return;
    await reviewSource.deleteWhitelist(item.entry_id, actorId);
    onChanged();
  }

  return (
    <li className="card">
      <p>
        {item.cidr} — {item.reason}
      </p>
      <form noValidate onSubmit={onUpdate}>
        <label>
          理由
          <input
            data-testid={`whitelist-update-reason-${item.entry_id}`}
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
          />
        </label>{" "}
        <button
          className="btn btn-primary"
          type="submit"
          data-testid={`whitelist-update-${item.entry_id}`}
        >
          更新
        </button>{" "}
        <button
          type="button"
          className="btn"
          data-testid={`whitelist-remove-${item.entry_id}`}
          onClick={() => void onRemove()}
        >
          刪除
        </button>
        {error ? (
          <p data-testid={`whitelist-update-error-${item.entry_id}`}>{error}</p>
        ) : null}
      </form>
    </li>
  );
}
