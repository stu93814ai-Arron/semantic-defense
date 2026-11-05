import { ipv4ToInt } from "./allowlistMatch";
import type { AllowlistItem, Decision } from "./types";

export type CidrCheck = { ok: true; cidr: string } | { ok: false; message: string };

function hostBitsZero(ipInt: number, prefix: number): boolean {
  if (prefix === 32) return true;
  const hostMask = 0xffffffff >>> prefix;
  return (ipInt & hostMask) === 0;
}

type PrefixOk = { ok: true; prefix: number };
type PrefixErr = { ok: false; message: string };

function parsePrefixPart(prefixPart: string | undefined): PrefixOk | PrefixErr {
  if (prefixPart === undefined) return { ok: true, prefix: 32 };
  if (!/^\d{1,2}$/.test(prefixPart)) {
    return { ok: false, message: "前綴必須為數字" };
  }
  const prefix = Number(prefixPart);
  if (prefix < 8 || prefix > 32) {
    return { ok: false, message: "IPv4 前綴須介於 /8 與 /32" };
  }
  return { ok: true, prefix };
}

function splitCidr(raw: string): { ipPart: string; prefixPart?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash < 0) return { ipPart: trimmed };
  const ipPart = trimmed.slice(0, slash);
  const prefixPart = trimmed.slice(slash + 1);
  if (!ipPart || prefixPart === "") return null;
  return { ipPart, prefixPart };
}

/** 白名單 CIDR：IPv4、前綴 ≥ /8；無前綴視為 /32；拒主機位非零。 */
export function validateAllowlistCidr(raw: string): CidrCheck {
  const parts = splitCidr(raw);
  if (!parts) return { ok: false, message: "請輸入 IP 或 CIDR" };
  const ipInt = ipv4ToInt(parts.ipPart);
  if (ipInt === null) return { ok: false, message: "僅支援 IPv4 位址" };
  const pref = parsePrefixPart(parts.prefixPart);
  if (!pref.ok) return pref;
  if (!hostBitsZero(ipInt, pref.prefix)) {
    return { ok: false, message: "主機位必須為 0" };
  }
  const cidr =
    pref.prefix === 32 && parts.prefixPart === undefined
      ? parts.ipPart
      : `${parts.ipPart}/${pref.prefix}`;
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
