/* eslint-disable security/detect-non-literal-fs-filename -- 測試夾具：路徑來自測試內常數與 mkdtemp 暫存目錄 */
// boundaries.mjs 夾具測試：每個案例在暫存目錄建一個最小的 repo，再執行腳本
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../boundaries.mjs");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Files = Record<string, string>;
const BASE: Files = {
  "apps/control-api/package.json": JSON.stringify({ name: "@sd/control-api" }),
  "apps/console/package.json": JSON.stringify({ name: "@sd/console" }),
  "packages/contracts/package.json": JSON.stringify({ name: "@sd/contracts" }),
};
const SENSOR_PKG: Files = { "apps/sensor-ingest/package.json": JSON.stringify({ name: "@sd/sensor-ingest" }) };

function run(files: Files): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), "sd-bnd-"));
  dirs.push(root);
  for (const [p, c] of Object.entries({ ...BASE, ...files })) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, c);
  }
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout + r.stderr };
}

describe("boundaries：sensor-ingest 尚不存在", () => {
  it("沒有 apps/sensor-ingest 也通過", () => expect(run({}).code).toBe(0));
});

describe("(a) sensor-ingest 不得依賴管理平面", () => {
  it("只依賴 contracts → 通過", () => {
    expect(run({ ...SENSOR_PKG, "apps/sensor-ingest/src/index.ts": 'import { X } from "@sd/contracts";\n' }).code).toBe(0);
  });
  it("import 套件名 @sd/control-api → 失敗", () => {
    const r = run({ ...SENSOR_PKG, "apps/sensor-ingest/src/index.ts": 'import { a } from "@sd/control-api";\n' });
    expect(r.code).toBe(1); expect(r.out).toContain("sensor-ingest 不得依賴 control-api");
  });
  it("相對路徑引用 console 原始碼 → 失敗", () => {
    const r = run({ ...SENSOR_PKG, "apps/sensor-ingest/src/index.ts": 'import x from "../../console/src/api";\n' });
    expect(r.code).toBe(1); expect(r.out).toContain("sensor-ingest 不得依賴 console");
  });
  it("package.json 依賴 control-api → 失敗", () => {
    const r = run({ "apps/sensor-ingest/package.json": JSON.stringify({ name: "@sd/sensor-ingest", dependencies: { "@sd/control-api": "workspace:*" } }) });
    expect(r.code).toBe(1); expect(r.out).toContain("dependencies.@sd/control-api");
  });
  it("管理平面反向依賴 sensor-ingest → 失敗", () => {
    const r = run({ ...SENSOR_PKG, "apps/control-api/src/x.ts": 'import "@sd/sensor-ingest";\n' });
    expect(r.code).toBe(1); expect(r.out).toContain("control-api 不得依賴 sensor-ingest");
  });
});

describe("(b) 管理平面設定不得指涉 sensor", () => {
  it("deploy/management 指涉 sensor-ingest → 失敗", () => {
    const r = run({ "deploy/management/compose.yaml": "services:\n  sensor-ingest:\n    image: x\n" });
    expect(r.code).toBe(1); expect(r.out).toContain("管理平面部署設定不得指涉 sensor-ingest");
  });
  it("deploy/management 指涉 deploy/sensor → 失敗", () => {
    expect(run({ "deploy/management/README.env": "INCLUDE=deploy/sensor/app.env\n" }).code).toBe(1);
  });
  it("管理 app 設定檔（.env）指涉 sensor-ingest → 失敗", () => {
    const r = run({ "apps/control-api/.env.example": "SENSOR_URL=http://sensor-ingest:9000\n" });
    expect(r.code).toBe(1); expect(r.out).toContain("管理平面設定不得指涉");
  });
  it("乾淨的 deploy/management → 通過", () => {
    expect(run({ "deploy/management/compose.yaml": "services:\n  control-api:\n    image: x\n" }).code).toBe(0);
  });
});

describe("(c) deploy/sensor 視為流量平面部署目錄", () => {
  it("乾淨的 deploy/sensor → 通過", () => {
    expect(run({ ...SENSOR_PKG, "deploy/sensor/compose.yaml": "services:\n  sensor-ingest:\n    ports: [\"9100:9100\"]\n" }).code).toBe(0);
  });
  it("deploy/sensor 指涉 control-api → 失敗", () => {
    const r = run({ "deploy/sensor/compose.yaml": "environment:\n  UPSTREAM: http://control-api:3000\n" });
    expect(r.code).toBe(1); expect(r.out).toContain("sensor 部署設定不得指涉管理平面");
  });
  it("deploy/sensor 不適用 CONSTRAINTS_PUBLISH_URL 例外 → 失敗", () => {
    expect(run({ "deploy/sensor/app.env": "CONSTRAINTS_PUBLISH_URL=https://x.example/c\n" }).code).toBe(1);
  });
  it("deploy/ 其他位置仍然紅燈", () => expect(run({ "deploy/other/a.yaml": "a: 1\n" }).code).toBe(1));
});

describe("(d) sensor-ingest 不得提供 /api、/login 路由", () => {
  it("/ingest 路由 → 通過", () => {
    expect(run({ ...SENSOR_PKG, "apps/sensor-ingest/src/server.ts": 'app.post("/ingest", h);\napp.get("/healthz", h);\n' }).code).toBe(0);
  });
  it("/api 路由 → 失敗", () => {
    const r = run({ ...SENSOR_PKG, "apps/sensor-ingest/src/server.ts": 'app.get("/api/apps", h);\n' });
    expect(r.code).toBe(1); expect(r.out).toContain("不得提供管理／登入路由");
  });
  it("/login 路由 → 失敗", () => {
    expect(run({ ...SENSOR_PKG, "apps/sensor-ingest/src/server.ts": "app.post('/login', h);\n" }).code).toBe(1);
  });
  it("/apiary 這類開頭相同的路徑不算 → 通過", () => {
    expect(run({ ...SENSOR_PKG, "apps/sensor-ingest/src/server.ts": 'app.get("/apiary", h);\n' }).code).toBe(0);
  });
  it("測試檔裡的探測字串不算 → 通過", () => {
    expect(run({ ...SENSOR_PKG, "apps/sensor-ingest/test/no-login.test.ts": 'expect(await get("/login")).toBe(404);\n' }).code).toBe(0);
  });
});
