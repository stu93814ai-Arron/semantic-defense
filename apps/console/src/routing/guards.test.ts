import { describe, expect, it } from "vitest";
import {
  decideApiGate,
  probeExact,
  probeUrl,
  resolveProtectedView,
} from "./guards";

describe("probeExact / probeUrl", () => {
  it("對應已知列表與動態路徑", () => {
    expect(probeExact("/judgments")).toBe("/api/judgments");
    expect(probeExact("/judgments/history")).toBe("/api/judgments");
    expect(probeExact("/constraints")).toBe("/api/constraints");
    expect(probeExact("/admin/users")).toBe("/api/admin/users");
    expect(probeExact("/audit")).toBe("/api/audit");
    expect(probeExact("/versions")).toBe("/api/versions");
    expect(probeExact("/health")).toBe("/api/health");
    expect(probeExact("/apps/new")).toBeNull();

    expect(probeUrl("/apps/new")).toBeNull();
    expect(probeUrl("/judgments/case-1")).toBe("/api/judgments/case-1");
    expect(probeUrl("/apps/app-alpha/map")).toBe("/api/apps/app-alpha/map");
    expect(probeUrl("/judgments")).toBe("/api/judgments");
    expect(probeUrl("/unknown")).toBeNull();
  });
});

describe("decideApiGate / resolveProtectedView", () => {
  it("401 ignore；403 deny；地圖 404 deny；其餘 ok", () => {
    expect(decideApiGate(401, "/judgments")).toBe("ignore");
    expect(decideApiGate(403, "/admin/users")).toBe("deny");
    expect(decideApiGate(404, "/apps/app-beta/map")).toBe("deny");
    expect(decideApiGate(404, "/judgments/c1")).toBe("ok");
    expect(decideApiGate(200, "/judgments")).toBe("ok");
  });

  it("畫面決策矩陣", () => {
    expect(resolveProtectedView("loading", "pending")).toBe("loading");
    expect(resolveProtectedView("ok", "pending")).toBe("loading");
    expect(resolveProtectedView("login", "pending")).toBe("login");
    expect(resolveProtectedView("deny", "ok")).toBe("deny");
    expect(resolveProtectedView("ok", "deny")).toBe("deny");
    expect(resolveProtectedView("ok", "ok")).toBe("empty");
  });
});
