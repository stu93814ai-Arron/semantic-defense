import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { LoginOutcome } from "../auth/session";

vi.mock("../auth", () => ({
  useAuth: vi.fn(),
}));

import { useAuth } from "../auth";
import { LoginPage } from "./LoginPage";

const login = vi.fn();

function renderLogin(opts: { state?: { expired?: boolean }; outcome?: LoginOutcome } = {}) {
  login.mockReturnValue(opts.outcome ?? { ok: true, role: "operator" });
  vi.mocked(useAuth).mockReturnValue({
    user: null,
    ready: true,
    login,
    logout: vi.fn(),
    refresh: vi.fn(),
  });
  render(
    <MemoryRouter initialEntries={[{ pathname: "/login", state: opts.state }]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/judgments" element={<div data-testid="landed">/judgments</div>} />
        <Route path="/apps/new" element={<div data-testid="landed">/apps/new</div>} />
        <Route path="/admin/users" element={<div data-testid="landed">/admin/users</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function submit(user: string, pass: string) {
  fireEvent.change(screen.getByTestId("login-username"), { target: { value: user } });
  fireEvent.change(screen.getByTestId("login-password"), { target: { value: pass } });
  fireEvent.click(screen.getByTestId("login-submit"));
}

beforeEach(() => {
  login.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LoginPage 既有流程與欄位", () => {
  it("保留帳號、密碼與送出 testid，成功後值班導向 /judgments", () => {
    renderLogin();
    expect(screen.getByRole("heading", { level: 1, name: "值勤登入" })).toBeTruthy();
    expect(screen.getByTestId("login-username")).toBeTruthy();
    expect(screen.getByTestId("login-password").getAttribute("type")).toBe("password");
    expect(screen.getByTestId("login-submit").textContent).toMatch(/登入/);
    expect(screen.getByTestId("login-password").getAttribute("autoComplete")).toBe("current-password");
    expect(document.querySelectorAll("form input")).toHaveLength(2);
    submit("operator1", "pass-operator-1");
    expect(login).toHaveBeenCalledWith("operator1", "pass-operator-1");
    expect(screen.getByTestId("landed").textContent).toBe("/judgments");
  });

  it("401 顯示既有錯誤訊息；不出現後端堆疊", () => {
    renderLogin({ outcome: { ok: false, message: "帳號或密碼錯誤" } });
    submit("no-such-user", "x");
    expect(screen.getByTestId("login-error").textContent).toBe("帳號或密碼錯誤");
    expect(screen.getByTestId("login-error").textContent).not.toMatch(/stack|internal|trace/i);
    expect(screen.queryByTestId("landed")).toBeNull();
  });
});

describe("LoginPage 版面（對開品牌與表單）", () => {
  it("木紋側顯示品牌與標語，表單側為 Welcome back 與稽核說明", () => {
    renderLogin();
    const page = document.querySelector("main.login-page") as HTMLElement | null;
    expect(page).toBeTruthy();
    const text = page?.textContent ?? "";
    expect(text).toMatch(/應用語意防禦/);
    expect(text).toMatch(/管理主控台/);
    expect(text).toMatch(/安靜地/);
    expect(text).toMatch(/守護每一次請求/);
    expect(text).toMatch(/Welcome back/i);
    expect(text).toMatch(/請以公司帳號登入。寫入操作將留存稽核紀錄。/);
    expect(text).toMatch(/Semantic Defense/);
  });

  it("不出現只接收鏡像流量或以 AI 偵測", () => {
    renderLogin();
    const text = document.querySelector("main.login-page")?.textContent ?? "";
    expect(text).not.toMatch(/只接收鏡像流量/);
    expect(text).not.toMatch(/以 AI 偵測/);
  });

  it("稽核說明不含「所有操作」", () => {
    renderLogin();
    const text = document.querySelector("main.login-page")?.textContent ?? "";
    expect(text).toMatch(/請以公司帳號登入/);
    expect(text).not.toMatch(/所有操作/);
  });

  it("帳號與密碼欄位預設為空", () => {
    renderLogin();
    expect((screen.getByTestId("login-username") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("login-password") as HTMLInputElement).value).toBe("");
  });

  it("不提供 SSO、系統狀態、模式或可操作的 AI 狀態", () => {
    renderLogin();
    expect(screen.queryByRole("button", { name: /SSO|單一登入|Google|SAML/i })).toBeNull();
    const text = (document.querySelector("main.login-page")?.textContent ?? "");
    expect(text).not.toMatch(/系統狀態|運作模式/);
    expect(screen.queryByRole("button", { name: /AI/ })).toBeNull();
    expect(screen.queryByTestId("ai-launch")).toBeNull();
  });
});

describe("LoginPage 逾時橫幅", () => {
  it("預設不顯示逾時橫幅；帶 expired 狀態時以 role=status 顯示", () => {
    renderLogin();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("工作階段已逾時，請重新登入。")).toBeNull();
    cleanup();
    renderLogin({ state: { expired: true } });
    const banner = screen.getByRole("status");
    expect(banner.textContent).toBe("工作階段已逾時，請重新登入。");
  });
});
