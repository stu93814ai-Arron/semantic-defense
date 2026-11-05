import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCaseSummary, parseConstraintDraft, parseRequestEvent, toCaseSummary } from "../src/index.js";

type Obj = Record<string, unknown>;
type Res = { ok: boolean; errors?: unknown[]; value?: unknown };
type Case = [string, () => Res];
const ROOT = new URL("../fixtures/", import.meta.url);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- 路徑僅來自本檔固定清單
const text = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const load = <T = Obj>(p: string): T => JSON.parse(text(p)) as T;
const meta = load<{ attack_text: string; forbidden_substrings: string[]; param_name: string }>("meta/instruction-attack-raw.json");
const noLeak = (s: string) => [meta.attack_text, ...meta.forbidden_substrings].every((x) => !s.includes(x));

const EVENTS = ["same-intent-a-read", "same-intent-b-read", "same-intent-c-read", "same-intent-admin-export",
  "normal-read", "normal-write", "instruction-attempt-sanitized"].map((n) => `events/${n}.json`);
const CASES = ["same-intent-read-to-admin", "normal-read-write", "instruction-attempt-sanitized"].map((n) => `cases/${n}.json`);
const ev = () => load("events/normal-read.json");
const cs = () => load("cases/same-intent-read-to-admin.json");
const t0 = () => (cs().transitions as Obj[])[0];
const draft = (): Obj => ({ app_id: "orders-app", route_family: "orders", from_state: "read", to_state: "admin",
  subject: { type: "actor", id: "actor-42" }, action: "deny", expires_at: "2026-11-05T13:00:00Z" });
const parsedEvent = (p: string) => {
  const r = parseRequestEvent(load(p));
  if (!r.ok) throw new Error(`fixture ${p} should parse`);
  return r.value;
};
const vals = (vs: unknown[], name: string, run: (v: unknown) => Res): Case[] =>
  vs.map((v) => [`${name}=${String(v)}`, () => run(v)]);

describe("準則1：契約外欄位整份拒絕（含巢狀）", () => {
  it.each<Case>([
    ...vals(["body", "params", "headers", "prompt", "raw", "param_values"], "event",
      (k) => parseRequestEvent({ ...ev(), [String(k)]: { id: "x" } })),
    ["param_roles.value", () => parseRequestEvent({ ...ev(), param_roles: [{ name: "id", type: "string", value: "v" }] })],
    ["case model_hint", () => parseCaseSummary({ ...cs(), model_hint: "block harder" })],
    ["transitions.note", () => parseCaseSummary({ ...cs(), transitions: [{ ...t0(), note: "x" }] })],
    ...vals(["instruction", "url", "rationale", "message", "constraint_id", "signed_at", "signature"], "draft",
      (k) => parseConstraintDraft({ ...draft(), [String(k)]: "x" })),
    ["subject.role", () => parseConstraintDraft({ ...draft(), subject: { type: "actor", id: "a", role: "admin" } })],
  ])("%s", (_n, run) => {
    const r = run();
    expect(r.ok).toBe(false);
    expect(r.errors?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("準則2：列舉限制", () => {
  it.each<Case>([
    ...vals(["read", "write", "auth", "admin"], "response_class", (v) => parseRequestEvent({ ...ev(), response_class: v })),
    ...vals(["actor", "session"], "subject.type", (type) => parseConstraintDraft({ ...draft(), subject: { type, id: "x" } })),
    ...vals(["log", "deny"], "action", (action) => parseConstraintDraft({ ...draft(), action })),
  ])("接受 %s", (_n, run) => expect(run().ok).toBe(true));
  it.each<Case>([
    ...vals(["delete", "READ", "", "admin ", 1, null, "Execute"], "response_class", (v) => parseRequestEvent({ ...ev(), response_class: v })),
    ["from_family", () => parseCaseSummary({ ...cs(), transitions: [{ ...t0(), from_family: "superuser" }] })],
    ["to_family", () => parseCaseSummary({ ...cs(), transitions: [{ ...t0(), to_family: "root" }] })],
    ["privileged_target", () => parseCaseSummary({ ...cs(), privileged_target: "everything" })],
    ...vals(["user", "Actor", "", null, "role"], "subject.type", (type) => parseConstraintDraft({ ...draft(), subject: { type, id: "x" } })),
    ...vals(["allow", "DENY", "", null, "block"], "action", (action) => parseConstraintDraft({ ...draft(), action })),
    ["from_state", () => parseConstraintDraft({ ...draft(), from_state: "unknown" })],
    ["to_state", () => parseConstraintDraft({ ...draft(), to_state: "sudo" })],
  ])("拒絕 %s 且不拋例外", (_n, run) => {
    expect(run).not.toThrow();
    expect(run().ok).toBe(false);
  });
});

describe("準則3＋5：參數原文不得進事件／摘要", () => {
  it.each([...EVENTS, ...CASES])("假資料零命中攻擊原文且可解析：%s", (p) => {
    expect(noLeak(text(p))).toBe(true);
    const r = p.startsWith("events/") ? parseRequestEvent(load(p)) : parseCaseSummary(load(p));
    expect(r.ok).toBe(true);
    if (r.ok) expect(noLeak(JSON.stringify(r.value))).toBe(true);
  });
  it("攻擊原文只存在 meta", () => expect(text("meta/instruction-attack-raw.json")).toContain(meta.attack_text));
  it("param_roles 只含 name/type；route_template 為模板", () => {
    const e = parsedEvent("events/instruction-attempt-sanitized.json");
    e.param_roles.forEach((r) => expect(Object.keys(r).sort()).toEqual(["name", "type"]));
    expect(e.route_template).toBe("/orders/{id}");
  });
  it("夾帶指示的事件被拒", () => {
    const base = load("events/instruction-attempt-sanitized.json");
    for (const bad of [{ params: { [meta.param_name]: meta.attack_text } }, { body: meta.attack_text },
      { prompt: meta.attack_text }, { route_template: `/orders/${meta.attack_text}` },
      { param_roles: [{ name: meta.param_name, type: "string", value: meta.attack_text }] }]) {
      expect(parseRequestEvent({ ...base, ...bad }).ok).toBe(false);
    }
  });
  it("toCaseSummary 不洩漏、與 fixture deep-equal、三模板相異", () => {
    const events = EVENTS.slice(0, 4).map(parsedEvent);
    const inject = toCaseSummary([parsedEvent("events/instruction-attempt-sanitized.json")]);
    expect(inject.ok && noLeak(JSON.stringify(inject.value))).toBe(true);
    const s = toCaseSummary(events, { distance: 0.82, normal_neighbor_count: 1200 });
    expect(s.ok && noLeak(JSON.stringify(s.value))).toBe(true);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(parseCaseSummary(s.value).ok).toBe(true);
    const got = { ...s.value } as Obj; delete got.case_id;
    const want = { ...load("cases/same-intent-read-to-admin.json") }; delete want.case_id;
    expect(got).toEqual(want);
    expect(new Set(events.slice(0, 3).map((e) => e.route_template)).size).toBe(3);
    expect(events.slice(0, 3).map((e) => e.response_class)).toEqual(["read", "read", "read"]);
    expect(events[3]?.response_class).toBe("admin");
  });
  it("toCaseSummary([]) 錯誤；單事件 transitions=[]", () => {
    const empty = toCaseSummary([]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors.length).toBeGreaterThan(0);
    const one = toCaseSummary([parsedEvent("events/normal-read.json")]);
    expect(one.ok).toBe(true);
    if (one.ok) {
      expect(one.value.transitions).toEqual([]);
      expect(one.value.privileged_target).toBe("read");
    }
  });
});

describe("準則4：假資料可重複讀取", () => {
  it.each([...EVENTS, ...CASES, "meta/instruction-attack-raw.json"])("%s", (p) => expect(load(p)).toEqual(load(p)));
  it("平常操作只在 read／write 之間", () => {
    for (const t of load<{ transitions: Obj[] }>("cases/normal-read-write.json").transitions) {
      expect(["read", "write"]).toContain(t.from_family);
      expect(["read", "write"]).toContain(t.to_family);
    }
  });
});
