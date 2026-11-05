import { createHash } from "node:crypto";
import { z } from "zod";

export const CONTRACTS_PACKAGE = "@semantic-defense/contracts";

const Family = z.enum(["read", "write", "auth", "admin"]);
export type Family = z.infer<typeof Family>;

const SEGMENT = /^(?:[A-Za-z0-9_-]+|\{[A-Za-z0-9_]+\})$/;
const RouteTemplate = z
  .string()
  .refine(
    (s) => s.startsWith("/") && s.slice(1).split("/").every((seg) => SEGMENT.test(seg)),
    { message: "route_template must be a path template" },
  );

const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const NonNegInt = z.number().int().nonnegative();

export const RequestEventSchema = z.strictObject({
  event_id: z.uuid(),
  app_id: Id,
  session_id: Id,
  actor_id: Id,
  ts: z.iso.datetime({ offset: true }),
  route_template: RouteTemplate,
  param_roles: z.array(z.strictObject({ name: Id, type: z.enum(["string", "number", "boolean"]) })),
  response_class: Family,
  sensitive: z.boolean(),
});
export type RequestEvent = z.infer<typeof RequestEventSchema>;

const Transition = z.strictObject({
  from_family: Family, to_family: Family, distance: z.number().nonnegative(), count: NonNegInt,
});

export const CaseSummarySchema = z.strictObject({
  case_id: z.uuid(),
  app_id: Id,
  actor_id: Id,
  session_id: Id,
  transitions: z.array(Transition),
  privileged_target: Family,
  normal_neighbor_count: NonNegInt,
});
export type CaseSummary = z.infer<typeof CaseSummarySchema>;

export const ConstraintDraftSchema = z.strictObject({
  app_id: Id,
  route_family: Id,
  from_state: Family,
  to_state: Family,
  subject: z.strictObject({ type: z.enum(["actor", "session"]), id: Id }),
  action: z.enum(["log", "deny"]),
  expires_at: z.iso.datetime({ offset: true }),
});
export type ConstraintDraft = z.infer<typeof ConstraintDraftSchema>;

export type ParseError = { path: string; message: string };
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: ParseError[] };

function safeParse<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  try {
    const r = schema.safeParse(input);
    if (r.success) return { ok: true, value: r.data };
    // 只回路徑與訊息，不回輸入值，避免把原文帶進錯誤。
    return {
      ok: false,
      errors: r.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.code })),
    };
  } catch {
    return { ok: false, errors: [{ path: "", message: "parse_failed" }] };
  }
}

export const parseRequestEvent = (input: unknown) => safeParse(RequestEventSchema, input);
export const parseCaseSummary = (input: unknown) => safeParse(CaseSummarySchema, input);
export const parseConstraintDraft = (input: unknown) => safeParse(ConstraintDraftSchema, input);

const ORDER: readonly Family[] = ["read", "write", "auth", "admin"];
const rank = (f: Family): number => ORDER.indexOf(f);

function stableUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type CaseSummaryOptions = { distance?: number; normal_neighbor_count?: number };
type Row = CaseSummary["transitions"][number];

function aggregate(sorted: RequestEvent[], distance: number): Row[] {
  const map = new Map<string, Row>();
  sorted.forEach((cur, i) => {
    const prev = sorted.at(i - 1);
    if (i === 0 || !prev || prev.response_class === cur.response_class) return;
    const key = `${prev.response_class}>${cur.response_class}`;
    const t = map.get(key);
    if (t) t.count += 1;
    else map.set(key, { from_family: prev.response_class, to_family: cur.response_class, distance, count: 1 });
  });
  return [...map.values()];
}

function highest(events: RequestEvent[]): Family {
  return events.reduce<Family>((acc, e) => (rank(e.response_class) > rank(acc) ? e.response_class : acc), "read");
}

export function toCaseSummary(
  events: RequestEvent[],
  opts: CaseSummaryOptions = {},
): ParseResult<CaseSummary> {
  if (!events.length) return { ok: false, errors: [{ path: "", message: "empty_events" }] };
  const sorted = [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const { app_id, actor_id, session_id } = sorted[0]!;
  return {
    ok: true,
    value: {
      case_id: stableUuid(`${app_id}|${actor_id}|${session_id}`),
      app_id, actor_id, session_id,
      transitions: aggregate(sorted, opts.distance ?? 0),
      privileged_target: highest(sorted),
      normal_neighbor_count: opts.normal_neighbor_count ?? 0,
    },
  };
}
