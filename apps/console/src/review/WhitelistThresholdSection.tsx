import { useEffect, useId, useState } from "react";
import type { Role } from "../roles";
import { AutoListSwitch } from "./AutoListSwitch";
import { ThresholdEditor } from "./ThresholdEditor";
import { DEFAULT_THRESHOLDS } from "./thresholds";
import { reviewSource } from "./reviewSource";

type Props = {
  role: Role | undefined;
  actorId: string | undefined;
  onChanged: () => void;
};

/**
 * 白名單頁「判定設定」區塊：自動上榜開關（僅 platform_admin 顯示）＋門檻。
 * 門檻優先走管理面 API，失敗時由 reviewSource 回退 demo；開關只走 API。
 */
export function WhitelistThresholdSection({ role, actorId, onChanged }: Props) {
  const headingId = useId();
  const [value, setValue] = useState(DEFAULT_THRESHOLDS);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void reviewSource.getThresholds().then((r) => {
      if (!cancelled && r.ok) setValue(r.value);
    });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return (
    <section className="card" aria-labelledby={headingId} data-testid="judgment-settings">
      <h2 id={headingId}>判定設定</h2>
      <AutoListSwitch role={role} source={reviewSource} />
      <ThresholdEditor
        value={value}
        onSave={async (next) => {
          if (!actorId) return { ok: false as const, message: "未登入" };
          const r = await reviewSource.updateThresholds(next, actorId);
          if (!r.ok) return { ok: false as const, message: r.message ?? "更新失敗" };
          setNonce((n) => n + 1);
          onChanged();
          return { ok: true as const, notice: "已更新門檻（已寫入稽核）" };
        }}
      />
    </section>
  );
}
