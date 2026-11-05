import { describe, expect, it } from "vitest";
import {
  accessFor,
  isAppMapPath,
  parseMeBody,
  titleFor,
  type SessionUser,
} from "./roles";

const op: SessionUser = { username: "operator1", role: "operator" };
const owner: SessionUser = { username: "owner1", role: "app_owner" };
const admin: SessionUser = { username: "admin1", role: "platform_admin" };

describe("accessFor", () => {
  it("login 路徑一律 ok", () => {
    expect(accessFor("/login", null)).toBe("ok");
    expect(accessFor("/login?next=/x", op)).toBe("ok");
  });

  it("未登入受保護路徑 → login", () => {
    expect(accessFor("/judgments", null)).toBe("login");
    expect(accessFor("/apps/new", null)).toBe("login");
    expect(accessFor("/admin/users", null)).toBe("login");
  });

  it("operator 僅值勤頁", () => {
    expect(accessFor("/judgments", op)).toBe("ok");
    expect(accessFor("/judgments/c1", op)).toBe("ok");
    expect(accessFor("/judgments/history", op)).toBe("ok");
    expect(accessFor("/constraints", op)).toBe("ok");
    expect(accessFor("/constraints/x", op)).toBe("ok");
    expect(accessFor("/blacklist", op)).toBe("ok");
    expect(accessFor("/blacklist/review", op)).toBe("ok");
    expect(accessFor("/whitelist", op)).toBe("deny");
    expect(accessFor("/apps/new", op)).toBe("deny");
    expect(accessFor("/admin/users", op)).toBe("deny");
  });

  it("app_owner 僅應用頁", () => {
    expect(accessFor("/apps/new", owner)).toBe("ok");
    expect(accessFor("/apps/app-alpha/map", owner)).toBe("ok");
    expect(accessFor("/judgments", owner)).toBe("deny");
    expect(accessFor("/admin/users", owner)).toBe("deny");
  });

  it("platform_admin 僅管理頁", () => {
    expect(accessFor("/admin/users", admin)).toBe("ok");
    expect(accessFor("/audit", admin)).toBe("ok");
    expect(accessFor("/versions", admin)).toBe("ok");
    expect(accessFor("/health", admin)).toBe("ok");
    expect(accessFor("/whitelist", admin)).toBe("ok");
    expect(accessFor("/blacklist", admin)).toBe("deny");
    expect(accessFor("/judgments", admin)).toBe("deny");
    expect(accessFor("/apps/new", admin)).toBe("deny");
  });

  it("未知路徑 deny", () => {
    expect(accessFor("/nope", op)).toBe("deny");
    expect(accessFor("/", admin)).toBe("deny");
  });
});

describe("titleFor / isAppMapPath", () => {
  it("靜態與動態標題", () => {
    expect(titleFor("/admin/users")).toBe("人員與角色");
    expect(titleFor("/apps/new")).toBe("應用接入");
    expect(titleFor("/judgments")).toBe("待判斷");
    expect(titleFor("/judgments/history")).toBe("判斷紀錄");
    expect(titleFor("/constraints")).toBe("生效限制");
    expect(titleFor("/audit")).toBe("稽核");
    expect(titleFor("/versions")).toBe("版本與影子流量");
    expect(titleFor("/health")).toBe("平台健康");
    expect(titleFor("/blacklist/review")).toBe("黑名單審核");
    expect(titleFor("/blacklist")).toBe("黑名單撤回");
    expect(titleFor("/whitelist")).toBe("白名單");
    expect(titleFor("/apps/app-alpha/map")).toBe("應用地圖");
    expect(titleFor("/judgments/case-1")).toBe("單一判斷");
    expect(titleFor("/unknown")).toBe("頁面");
  });

  it("isAppMapPath", () => {
    expect(isAppMapPath("/apps/a/map")).toBe(true);
    expect(isAppMapPath("/apps/new")).toBe(false);
    expect(isAppMapPath("/judgments")).toBe(false);
  });
});

describe("parseMeBody", () => {
  it("只接受完整 username/role", () => {
    expect(parseMeBody({ username: "u", role: "operator" })).toEqual({
      username: "u",
      role: "operator",
    });
    expect(parseMeBody(null)).toBeNull();
    expect(parseMeBody({ username: "u" })).toBeNull();
    expect(parseMeBody({ username: "u", role: "nope" })).toBeNull();
  });
});
