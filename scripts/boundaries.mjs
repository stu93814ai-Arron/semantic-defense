/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection -- CI 腳本：路徑與鍵皆來自本倉庫目錄走訪與 package.json，非外部輸入 */
// 流量平面／管理平面依賴邊界與部署設定分離檢查（PLAN.md：入口配接為獨立程序，與控制程序分開部署）
// 規則：
//   gateway-adapter → 只可依賴 packages/contracts、packages/gate（及外部 npm 套件）
//   control-api、console → 不可依賴 gateway-adapter
// 檢查面：原始碼 import/export/require/import()（套件名、相對路徑、tsconfig paths 別名）＋ package.json 依賴
// 部署：deploy/gateway-adapter/** 與 deploy/management/** 分開；deploy/ 下其他位置、或單一檔同時指涉兩平面 → 紅燈
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, relative, dirname, sep } from "node:path";

const ROOT = process.cwd();
const GW = "gateway-adapter", MGMT = ["control-api", "console"], GW_ALLOWED = ["contracts", "gate"];
const errors = [];
const SKIP = new Set(["node_modules", "dist", "coverage", "playwright-report", "test-results", ".git"]);
const walk = (d, out = []) => {
  if (!existsSync(d)) return out;
  for (const n of readdirSync(d)) {
    if (SKIP.has(n)) continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };

// 工作區套件：名稱 → { kind: "app"|"pkg", dir }
const ws = new Map();
for (const kind of ["apps", "packages"]) for (const d of existsSync(kind) ? readdirSync(kind) : []) {
  const pj = readJson(join(kind, d, "package.json"));
  ws.set(d, { kind, dir: resolve(kind, d), name: pj?.name });
}
const byName = new Map([...ws].filter(([, v]) => v.name).map(([k, v]) => [v.name, k]));
const ownerOf = (abs) => { for (const [k, v] of ws) if (abs === v.dir || abs.startsWith(v.dir + sep)) return k; return undefined; };
const forbidden = (from, to) => {
  if (!to || to === from) return false;
  if (from === GW) return !(ws.get(to)?.kind === "packages" && GW_ALLOWED.includes(to));
  if (MGMT.includes(from)) return to === GW;
  return false;
};

// tsconfig paths 別名（套件與根目錄）
const aliases = (appDir) => {
  const out = [];
  for (const tc of [join(appDir, "tsconfig.json"), join(ROOT, "tsconfig.base.json"), join(ROOT, "tsconfig.json")]) {
    const c = readJson(tc)?.compilerOptions; if (!c?.paths) continue;
    const base = resolve(dirname(tc), c.baseUrl ?? ".");
    for (const [k, vs] of Object.entries(c.paths)) for (const v of vs) out.push({ prefix: k.replace(/\*$/, ""), target: resolve(base, v.replace(/\*$/, "")) });
  }
  return out;
};
const SPEC = /(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const targetOf = (spec, file, al) => {
  if (spec.startsWith(".")) return ownerOf(resolve(dirname(file), spec));
  for (const [name, k] of byName) if (spec === name || spec.startsWith(name + "/")) return k;
  for (const a of al) if (a.prefix && spec.startsWith(a.prefix)) return ownerOf(resolve(a.target, spec.slice(a.prefix.length)));
  if (spec.startsWith("/")) return ownerOf(spec);
  return undefined;
};

for (const [app, info] of ws) {
  if (info.kind !== "apps" || (app !== GW && !MGMT.includes(app))) continue;
  const al = aliases(info.dir);
  for (const f of walk(info.dir).filter((f) => /\.(m|c)?[jt]sx?$/.test(f))) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(SPEC)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const to = targetOf(spec, f, al);
      if (forbidden(app, to)) errors.push(`${relative(ROOT, f)}: ${app} 不得依賴 ${to}（"${spec}"）`);
    }
  }
  const pj = readJson(join(info.dir, "package.json")) ?? {};
  for (const sec of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
    for (const [dep, ver] of Object.entries(pj[sec] ?? {})) {
      let to = byName.get(dep);
      const m = /^(?:file|link|workspace):(.+)$/.exec(String(ver));
      if (!to && m && m[1].startsWith(".")) to = ownerOf(resolve(info.dir, m[1]));
      if (forbidden(app, to)) errors.push(`${relative(ROOT, join(info.dir, "package.json"))}: ${sec}.${dep} → ${app} 不得依賴 ${to}`);
    }
}

// 部署設定分離
const GW_RE = /gateway[-_]?adapter/i, MG_RE = /control[-_]?api|\bconsole\b/i;
for (const f of walk("deploy")) {
  const r = relative("deploy", f).split(sep);
  const t = readFileSync(f, "utf8");
  if (r[0] === "gateway-adapter") { if (MG_RE.test(t)) errors.push(`${f}: 入口部署設定不得指涉管理平面（control-api／console）`); }
  else if (r[0] === "management") { if (GW_RE.test(t)) errors.push(`${f}: 管理平面部署設定不得指涉 gateway-adapter`); }
  else errors.push(`${f}: 部署設定須放在 deploy/gateway-adapter/ 或 deploy/management/`);
}
// 根目錄與 apps 內常見部署檔（compose、k8s、Dockerfile）不得同時指涉兩平面
const DEPLOY_FILE = /(^|\/)(docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml|Dockerfile[^/]*|[^/]*\.k8s\.ya?ml|Procfile)$/;
for (const f of [...readdirSync(".").filter((n) => !statSync(n).isDirectory()), ...walk("apps")].filter((f) => DEPLOY_FILE.test(f))) {
  const t = readFileSync(f, "utf8");
  if (GW_RE.test(t) && MG_RE.test(t)) errors.push(`${f}: 單一部署檔同時指涉入口與管理平面`);
}

for (const e of errors) console.log(`❌ ${e}`);
console.log(errors.length ? `boundaries: ${errors.length} 項違規` : "boundaries: OK（流量／管理平面依賴與部署設定分離）");
process.exit(errors.length ? 1 : 0);
