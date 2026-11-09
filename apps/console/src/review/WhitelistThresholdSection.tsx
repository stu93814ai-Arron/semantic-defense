import { ThresholdEditor } from "./ThresholdEditor";
import { getThresholds, reviewUpdateThresholds } from "./demoStore";

type Props = {
  actorId: string | undefined;
  onChanged: () => void;
};

/** 白名單頁門檻區塊：接 demoStore；路由已限 platform_admin。 */
export function WhitelistThresholdSection({ actorId, onChanged }: Props) {
  return (
    <ThresholdEditor
      value={getThresholds()}
      onSave={(next) => {
        if (!actorId) return { ok: false as const, message: "未登入" };
        const r = reviewUpdateThresholds(next, actorId);
        if (!r.ok) return { ok: false as const, message: r.message };
        onChanged();
        return { ok: true as const, notice: "已更新門檻（已寫入稽核）" };
      }}
    />
  );
}
