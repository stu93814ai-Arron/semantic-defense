import { useEffect, useState } from "react";
import { ThresholdEditor } from "./ThresholdEditor";
import { DEFAULT_THRESHOLDS } from "./thresholds";
import { reviewSource } from "./reviewSource";

type Props = {
  actorId: string | undefined;
  onChanged: () => void;
};

/** 白名單頁門檻區塊：優先走管理面 API，失敗時由 reviewSource 回退 demo。 */
export function WhitelistThresholdSection({ actorId, onChanged }: Props) {
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
  );
}
