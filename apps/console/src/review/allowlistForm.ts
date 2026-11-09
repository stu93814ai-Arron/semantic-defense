import {
  AllowlistCreateSchema,
  AllowlistUpdateSchema,
  assertAllowlistCidr,
} from "@semantic-defense/contracts/browser";
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

function reasonMessage(issues: { message?: string }[]): string {
  const codes = issues.map((i) => i.message ?? "");
  if (codes.includes("control_or_bidi_char")) {
    return "理由不可含控制字元、雙向字元或零寬字元";
  }
  if (codes.some((c) => c.includes("Too small") || c === "too_small")) {
    return "理由須為 1–200 字";
  }
  if (codes.some((c) => c.includes("Too big") || c === "too_big")) {
    return "理由須為 1–200 字";
  }
  return "理由格式不符規範（1–200 字，不可含控制／雙向／零寬字元）";
}

export function addAllowlist(
  input: { cidr: string; reason: string; expires_at?: string | null },
  ctx: { actorId: string; now: string },
): Decision<AllowlistItem> {
  const parsed = AllowlistCreateSchema.safeParse({
    cidr: input.cidr.trim(),
    reason: input.reason,
    expires_at: input.expires_at === undefined ? null : input.expires_at,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const cidrIssue = issues.find((i) => i.path[0] === "cidr");
    if (cidrIssue) {
      return {
        ok: false,
        code: "invalid_cidr",
        message: input.cidr.trim()
          ? "IP 或 CIDR 格式不符規範"
          : "請輸入 IP 或 CIDR",
      };
    }
    const reasonIssues = issues.filter((i) => i.path[0] === "reason");
    return {
      ok: false,
      code: "invalid_reason",
      message: reasonMessage(reasonIssues.length ? reasonIssues : issues),
    };
  }
  const { cidr, reason, expires_at } = parsed.data;
  const item: AllowlistItem = {
    entry_id: `wl-${ctx.now}-${cidr}`,
    cidr,
    reason,
    created_by: ctx.actorId,
    created_at: ctx.now,
    expires_at,
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

export function updateAllowlist(
  item: AllowlistItem,
  input: { reason: string; expires_at: string | null },
  ctx: { actorId: string; now: string },
): Decision<AllowlistItem> {
  const parsed = AllowlistUpdateSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const reasonIssues = issues.filter((i) => i.path[0] === "reason");
    return {
      ok: false,
      code: "invalid_reason",
      message: reasonMessage(reasonIssues.length ? reasonIssues : issues),
    };
  }
  const next: AllowlistItem = {
    ...item,
    reason: parsed.data.reason,
    expires_at: parsed.data.expires_at,
  };
  return {
    ok: true,
    value: next,
    audit: {
      action: "whitelist.update",
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
