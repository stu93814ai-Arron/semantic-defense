/* eslint-disable security/detect-non-literal-fs-filename -- 測試夾具：路徑來自測試內常數與 mkdtemp 暫存目錄 */
// audit-allow.mjs：正式例外清單是空的。只用合成的 audit JSON 夾具，不連 registry。
// 過期、缺欄與「公告已不在掃描」都用測試內注入的假例外證明，不寫進 EXCEPTIONS。
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXCEPTIONS, evaluateAudit, taipeiToday } from "../audit-allow.mjs";

type Adv = { severity: string; module_name: string; github_advisory_id: string; vulnerable_versions: string; patched_versions: string; findings: { version: string; paths: string[] }[] };
const PICO: Adv = { severity: "high", module_name: "picomatch", github_advisory_id: "GHSA-fc5q-39xc-vjpf", vulnerable_versions: "<=4.0.7",
  patched_versions: "<0.0.0", findings: [{ version: "4.0.7", paths: [".>typescript-eslint>tinyglobby>picomatch"] }] };
const meta = (high: number, critical = 0) => ({ vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical } });
const isSev = (a: Partial<Adv>, s: string) => String(a.severity ?? "").toLowerCase() === s;
const scan = (...advs: Partial<Adv>[]) => {
  const all = advs.map(a => ({ ...PICO, ...a }));
  return { advisories: Object.fromEntries(all.map((a, i) => [String(i + 1), a])),
    metadata: meta(all.filter(a => isSev(a, "high")).length, all.filter(a => isSev(a, "critical")).length) };
};
const OK_DAY = "2026-11-30";

describe("evaluateAudit：正式清單為空，舊的 picomatch 放行條件不再成立", () => {
  it("舊 picomatch GHSA 在 2026-11-30 也擋下，且不在正式清單", () => {
    const r = evaluateAudit(scan({}), OK_DAY);
    expect(r.ok).toBe(false);
    expect(r.allowed).toHaveLength(0);
    expect(EXCEPTIONS).toEqual([]);
  });
  it("2026-12-01 起 picomatch 仍擋下，整份掃描不因已移除的例外到期", () => {
    for (const d of ["2026-12-01", "2026-12-02", "2027-01-01"]) {
      const r = evaluateAudit(scan({}), d);
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).not.toContain("例外已於");
    }
  });
  it("沒有 finding 時，2026-11-30 與 2026-12-01 都通過", () => {
    expect(evaluateAudit({ advisories: {}, metadata: meta(0) }, "2026-12-01").ok).toBe(true);
    expect(evaluateAudit({ advisories: {}, metadata: meta(0) }, OK_DAY).ok).toBe(true);
  });
  it.each([
    ["其他 GHSA", { github_advisory_id: "GHSA-aaaa-bbbb-cccc" }],
    ["其他套件", { module_name: "micromatch" }],
    ["critical 的其他 GHSA", { severity: "critical", github_advisory_id: "GHSA-aaaa-bbbb-cccc" }],
    ["vulnerable_versions 不同", { vulnerable_versions: "<=4.0.8" }],
    ["出現修補版", { patched_versions: ">=4.0.8" }],
    ["修補版為其他字串", { patched_versions: ">=5.0.0" }],
    ["版本 >4.0.7", { findings: [{ version: "4.0.8", paths: [] }] }],
    ["版本 4.1.0", { findings: [{ version: "4.0.7", paths: [] }, { version: "4.1.0", paths: [] }] }],
    ["版本 5.0.0", { findings: [{ version: "5.0.0", paths: [] }] }],
    ["版本無法解析", { findings: [{ version: "4.0.7-beta.1", paths: [] }] }],
    ["沒有 findings", { findings: [] }],
    ["版本前綴 v4.0.7", { findings: [{ version: "v4.0.7", paths: [] }] }],
    ["版本 1.4.0.7（未錨定開頭時會被當成 4.0.7）", { findings: [{ version: "1.4.0.7", paths: [] }] }],
    ["版本 4.0.7.1", { findings: [{ version: "4.0.7.1", paths: [] }] }],
  ])("%s → 擋", (_l, a) => {
    const r = evaluateAudit(scan(a), OK_DAY);
    expect(r.ok).toBe(false);
    expect(r.allowed).toHaveLength(0);
  });
  it("修補版為空字串的 picomatch 也不再放行", () => {
    expect(evaluateAudit(scan({ patched_versions: "" }), OK_DAY).ok).toBe(false);
  });
  it("較舊的 picomatch 版本也不再放行", () => {
    expect(evaluateAudit(scan({ findings: [{ version: "2.3.1", paths: [] }, { version: "4.0.7", paths: [] }] }), OK_DAY).ok).toBe(false);
  });
  it("例外與另一筆 high 並存 → 擋", () => {
    expect(evaluateAudit(scan({}, { github_advisory_id: "GHSA-aaaa-bbbb-cccc" }), OK_DAY).ok).toBe(false);
  });
  it("moderate／low 不擋", () => {
    expect(evaluateAudit(scan({ severity: "moderate", github_advisory_id: "GHSA-g3hv-75wg-m249", module_name: "minimatch" }), OK_DAY).ok).toBe(true);
  });
});

describe("evaluateAudit：severity 正規化、metadata 核對與台北日期", () => {
  it.each([["HIGH"], ["Critical"], ["CRITICAL"], ["severe"], [""], [undefined]])("其他 GHSA 的 severity=%s → 擋（只有 info/low/moderate 可略過）", sev => {
    const r = evaluateAudit(scan({ severity: sev as string, github_advisory_id: "GHSA-aaaa-bbbb-cccc" }), OK_DAY);
    expect(r.ok).toBe(false);
  });
  it("severity 大小寫正規化：MODERATE、Low、INFO 可略過；HIGH 一律擋下", () => {
    for (const sev of ["MODERATE", "Low", "INFO"]) expect(evaluateAudit(scan({ severity: sev, github_advisory_id: "GHSA-aaaa-bbbb-cccc" }), OK_DAY).ok).toBe(true);
    const high = evaluateAudit(scan({ severity: "HIGH" }), OK_DAY);
    expect(high.ok).toBe(false);
    expect(high.allowed).toHaveLength(0);
  });
  it("metadata 交叉核對：缺少或與 advisories 的 high/critical 數不符 → 擋", () => {
    expect(evaluateAudit({ advisories: {}, metadata: meta(1) }, OK_DAY).ok).toBe(false);
    expect(evaluateAudit({ advisories: {}, metadata: meta(0, 2) }, OK_DAY).ok).toBe(false);
    expect(evaluateAudit({ ...scan({}), metadata: meta(2) }, OK_DAY).ok).toBe(false);
    expect(evaluateAudit({ ...scan({}), metadata: meta(0) }, OK_DAY).ok).toBe(false);
    expect(evaluateAudit({ advisories: scan({}).advisories }, OK_DAY).ok).toBe(false);
    expect(evaluateAudit({ advisories: {}, metadata: {} }, OK_DAY).ok).toBe(false);
    expect(evaluateAudit({ ...scan({ severity: "HIGH" }), metadata: meta(1) }, OK_DAY).ok).toBe(false);
    expect(evaluateAudit({ advisories: {}, metadata: meta(0) }, OK_DAY).ok).toBe(true);
  });
  it("advisories 是陣列 → 擋", () => {
    expect(evaluateAudit({ advisories: [], metadata: meta(0) }, OK_DAY).ok).toBe(false);
  });
  it("taipeiToday 以 Asia/Taipei 計算日期（UTC 11-30 16:00 已是台北 12-01）", () => {
    expect(taipeiToday(new Date("2026-11-30T16:00:00Z"))).toBe("2026-12-01");
    expect(taipeiToday(new Date("2026-11-30T15:59:59Z"))).toBe("2026-11-30");
  });
  it("audit 輸出錯誤或格式不符 → 擋（失敗即關閉）", () => {
    expect(evaluateAudit({ error: { code: "ERR" } }, OK_DAY).ok).toBe(false);
    expect(evaluateAudit({}, OK_DAY).ok).toBe(false);
    expect(evaluateAudit(null, OK_DAY).ok).toBe(false);
  });
});

// 假例外只注入在測試裡，不寫進正式清單。
type Exc = { id: string; module: string; vulnerable: string; maxVersion: number[]; expires?: string; reason?: string };
type AuditOut = { ok: boolean; allowed: string[]; errors: string[]; warnings?: string[] };
const auditWith = evaluateAudit as (scan: unknown, today: string, exceptions?: readonly Exc[]) => AuditOut;
const FAKE: Exc = { id: "GHSA-test-test-test", module: "example-pkg", vulnerable: "<1.0.0", maxVersion: [0, 9, 9], expires: "2026-12-01", reason: "測試注入，不在正式清單" };
const emptyScan = { advisories: {}, metadata: meta(0) };
const fakeScan = () => scan({ severity: "high", module_name: FAKE.module, github_advisory_id: FAKE.id, vulnerable_versions: FAKE.vulnerable,
  patched_versions: "<0.0.0", findings: [{ version: "0.9.0", paths: ["tools>example-pkg"] }] });
const warned = (r: AuditOut, seen: string[]) => `${(r.warnings ?? []).join("\n")}\n${seen.join("\n")}`;
function spyWarn(run: (seen: string[]) => void) {
  const seen: string[] = [];
  const orig = console.warn;
  console.warn = ((...args: unknown[]) => { seen.push(args.map(String).join(" ")); }) as typeof console.warn;
  try { run(seen); } finally { console.warn = orig; }
}

describe("evaluateAudit：空清單、缺欄與已不在掃描的公告", () => {
  const days = ["2026-01-01", "2026-11-30", "2026-12-01", "2027-01-01"];
  it("today ≥ 2026-12-01 且沒有任何 finding → ok", () => {
    for (const today of ["2026-12-01", "2026-12-02", "2027-01-01"]) {
      const r = auditWith(emptyScan, today);
      expect(r.ok).toBe(true);
      expect(r.errors).toEqual([]);
    }
  });
  it("任何 high／critical（含舊 picomatch GHSA-fc5q-39xc-vjpf）在任何日期一律擋下", () => {
    for (const today of days) {
      for (const adv of [{}, { severity: "critical" }, { severity: "HIGH", github_advisory_id: "GHSA-aaaa-bbbb-cccc", module_name: "left-pad" },
        { severity: "critical", github_advisory_id: "GHSA-zzzz-yyyy-xxxx", module_name: "other" }]) {
        const r = auditWith(scan(adv), today);
        expect(r.ok).toBe(false);
        expect(r.allowed).toHaveLength(0);
      }
    }
  });
  it("注入的例外 id 已不在掃描 → 警告含 id 與應移除此例外，且不失敗", () => {
    spyWarn(seen => {
      const r = auditWith(emptyScan, OK_DAY, [FAKE]);
      expect(r.ok).toBe(true);
      expect(r.errors).toEqual([]);
      expect(warned(r, seen)).toContain(FAKE.id);
      expect(warned(r, seen)).toContain("應移除此例外");
      const other = auditWith(scan({ github_advisory_id: "GHSA-aaaa-bbbb-cccc" }), OK_DAY, [FAKE]);
      expect(other.ok).toBe(false);
      expect(other.errors.join("\n")).not.toContain("應移除此例外");
      expect(warned(other, seen)).toContain("應移除此例外");
    });
  });
  it("注入的例外缺少理由、缺少到期日，或已到期 → 失敗", () => {
    for (const reason of [undefined, "", "   "]) {
      const r = auditWith(emptyScan, OK_DAY, [{ ...FAKE, reason }]);
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toContain("缺少理由");
    }
    const noDate = auditWith(emptyScan, OK_DAY, [{ ...FAKE, expires: "" }]);
    expect(noDate.ok).toBe(false);
    expect(noDate.errors.join("\n")).toContain("缺少到期日");
    const expired = auditWith(emptyScan, OK_DAY, [{ ...FAKE, expires: OK_DAY }]);
    expect(expired.ok).toBe(false);
    expect(expired.errors.join("\n")).toContain(`例外已於 ${OK_DAY} 到期`);
  });
  it("注入的例外 id 仍在掃描且條件相符 → 放行，且不提示應移除", () => {
    spyWarn(seen => {
      const r = auditWith(fakeScan(), OK_DAY, [FAKE]);
      expect(r.ok).toBe(true);
      expect(r.allowed[0]).toContain(FAKE.id);
      expect(warned(r, seen)).not.toContain("應移除此例外");
    });
  });
});

// audit.sh：第一關 --prod 沒有任何例外；用假的 pnpm（PATH 最前面）跑腳本副本
const ROOT = resolve(__dirname, "../..");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function runAudit(prodExit: number, fullJson: unknown): { code: number; out: string; calls: string[] } {
  const root = mkdtempSync(join(tmpdir(), "sd-audit-"));
  dirs.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  for (const f of ["audit.sh", "audit-allow.mjs"]) copyFileSync(join(ROOT, "scripts", f), join(root, "scripts", f));
  writeFileSync(join(root, "full.json"), JSON.stringify(fullJson));
  const stub = `#!/usr/bin/env bash\necho "$*" >> "${root}/calls.txt"\ncase "$*" in *--prod*) exit ${prodExit};; *--json*) cat "${root}/full.json"; exit 1;; esac\nexit 0\n`;
  writeFileSync(join(root, "bin", "pnpm"), stub);
  chmodSync(join(root, "bin", "pnpm"), 0o755);
  const r = spawnSync("bash", [join(root, "scripts", "audit.sh")], { encoding: "utf8", env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` } });
  return { code: r.status ?? -1, out: r.stdout + r.stderr, calls: readFileSync(join(root, "calls.txt"), "utf8").trim().split("\n") };
}

describe("audit.sh：--prod 關卡沒有例外", () => {
  it("第一個 pnpm audit 是 --prod --audit-level high，且在例外邏輯之前、不經過例外邏輯", () => {
    const sh = readFileSync(join(ROOT, "scripts/audit.sh"), "utf8").split("\n");
    const prod = sh.findIndex(l => l.startsWith("pnpm audit"));
    const cmd = sh.find(l => l.startsWith("pnpm audit"));
    expect(cmd).toMatch(/^pnpm audit --prod --audit-level high \|\| /);
    expect(cmd).not.toMatch(/audit-allow|ignore/);
    expect(prod).toBeLessThan(sh.findIndex(l => l.startsWith("node scripts/audit-allow.mjs")));
    expect(sh.join("\n")).not.toMatch(/--audit-level critical|AUDIT_TODAY|ignoreGhsas/);
  });
  it("--prod 有 high（就算是 picomatch）→ 立刻失敗，不跑完整掃描", () => {
    const r = runAudit(1, scan({}));
    expect(r.code).not.toBe(0);
    expect(r.calls).toEqual(["audit --prod --audit-level high"]);
  });
  it("--prod 通過但完整掃描有其他 high → 失敗", () => {
    const r = runAudit(0, scan({ github_advisory_id: "GHSA-aaaa-bbbb-cccc" }));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("GHSA-aaaa-bbbb-cccc");
  });
});
