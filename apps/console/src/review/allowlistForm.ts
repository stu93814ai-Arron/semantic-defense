import { assertAllowlistCidr } from "@semantic-defense/contracts/browser";
import type { AllowlistItem, Decision } from "./types";

export type CidrCheck = { ok: true; cidr: string } | { ok: false; message: string };

/** 白名單 CIDR：委派 contracts assertAllowlistCidr（含 IPv6／保留／canonical）。 */
export function validateAllowlistCidr(raw: string): CidrCheck {
  const cidr = raw.trim();
  if (!cidr) return { ok: false, message: "請輸入 IP 或 CIDR" };
  if (!assertAllowlistCidr(cidr)) {
    return { ok: false, message: "IP 或 CIDR 格式不符規範" };
  }
  return { ok: true, cidr };
}

export function addAllowlist(
  input: { cidr: string; reason: string },
  ctx: { actorId: string; now: string },
): Decision<AllowlistItem> {
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 200) {
    return {
      ok: false,
      code: "invalid_reason",
      message: "理由須為 1–200 字",
    };
  }
  const check = validateAllowlistCidr(input.cidr);
  if (!check.ok) {
    return { ok: false, code: "invalid_cidr", message: check.message };
  }
  const item: AllowlistItem = {
    entry_id: `wl-${ctx.now}-${check.cidr}`,
    cidr: check.cidr,
    reason,
    created_by: ctx.actorId,
    created_at: ctx.now,
    expires_at: null,
  };
  return {
    ok: true,
    value: item,
    audit: {
      action: "whitelist.add",
      actor_id: ctx.actorId,
      at: ctx.now,
      target_id: item.entry_id,
      detail: item.cidr,
    },
  };
}

export function removeAllowlist(
  item: AllowlistItem,
  ctx: { actorId: string; now: string },
): Decision<{ entry_id: string }> {
  return {
    ok: true,
    value: { entry_id: item.entry_id },
    audit: {
      action: "whitelist.remove",
      actor_id: ctx.actorId,
      at: ctx.now,
      target_id: item.entry_id,
      detail: item.cidr,
    },
  };
}
