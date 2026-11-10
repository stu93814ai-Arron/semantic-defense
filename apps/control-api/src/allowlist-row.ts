import type { AllowlistEntry } from "@semantic-defense/contracts";

export const ALLOWLIST_COLS = "entry_id, cidr, reason, created_by, created_at, expires_at";
export type AllowlistRow = {
  entry_id: string; cidr: string; reason: string; created_by: string;
  created_at: string; expires_at: string | null;
};

const iso = (ms: string | number) => new Date(Number(ms)).toISOString();

export const toAllowlistEntry = (r: AllowlistRow): AllowlistEntry => ({
  entry_id: r.entry_id, cidr: r.cidr, reason: r.reason, created_by: r.created_by,
  created_at: iso(r.created_at), expires_at: r.expires_at === null ? null : iso(r.expires_at),
});
