import { describe, expect, it } from "vitest";
import { loginOutcomeFrom } from "./session";

describe("loginOutcomeFrom", () => {
  it("成功帶 role；失敗帶原文 message", () => {
    expect(
      loginOutcomeFrom({
        ok: true,
        user: { username: "a", role: "operator" },
      }),
    ).toEqual({ ok: true, role: "operator" });
    expect(
      loginOutcomeFrom({
        ok: false,
        message: "帳號或密碼錯誤，請稍後再試",
      }),
    ).toEqual({ ok: false, message: "帳號或密碼錯誤，請稍後再試" });
  });
});
