import { assertAllowlistCidr } from "@semantic-defense/contracts";

/** 安裝種子的 created_by；用以辨識不可刪、不可設定到期的列。 */
export const CRITICAL_ALLOWLIST_ACTOR = "system:install";
export const CRITICAL_ALLOWLIST_REASON = "critical-infrastructure";

/** 未設定或空白 → 不動既有種子；none → 清空全部種子；其餘為要同步的 CIDR 清單。 */
export type CriticalAllowlist =
  | { kind: "leave" }
  | { kind: "clear" }
  | { kind: "cidrs"; cidrs: string[] };

/**
 * 解析 SD_CRITICAL_ALLOWLIST（逗號分隔 CIDR）。未設定或空白（trim 後）→ leave。
 * 單獨的 none（可重複）→ clear。none 與 CIDR 混用、缺前綴、無法通過既有白名單 CIDR 驗證，
 * 或寬於種子前綴上限（IPv4 ≥/16、IPv6 ≥/48）→ 拋錯；訊息不含該值（避免 log 帶 IP）。
 */
function seedPrefixAllowed(cidr: string): boolean {
  const slash = cidr.lastIndexOf("/");
  if (slash < 0) return false;
  const prefix = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix)) return false;
  return cidr.includes(":") ? prefix >= 48 : prefix >= 16;
}

export function parseCriticalAllowlist(raw: string | undefined): CriticalAllowlist {
  if (raw === undefined || raw.trim() === "") return { kind: "leave" };
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.includes("none")) {
    if (parts.some((p) => p !== "none")) {
      throw new Error("SD_CRITICAL_ALLOWLIST cannot mix none with a CIDR");
    }
    return { kind: "clear" };
  }
  for (const cidr of parts) {
    if (!cidr.includes("/")) {
      throw new Error("SD_CRITICAL_ALLOWLIST CIDR must include a prefix");
    }
    if (!assertAllowlistCidr(cidr)) {
      throw new Error("SD_CRITICAL_ALLOWLIST contains an invalid CIDR");
    }
    if (!seedPrefixAllowed(cidr)) {
      throw new Error("SD_CRITICAL_ALLOWLIST contains a CIDR broader than IPv4 /16 or IPv6 /48");
    }
  }
  return { kind: "cidrs", cidrs: parts };
}
