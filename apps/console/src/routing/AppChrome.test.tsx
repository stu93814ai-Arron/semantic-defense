import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { AuthProvider } from "../auth";
import * as api from "../api";
import { titleFor, type SessionUser } from "../roles";

const op: SessionUser = { username: "operator1", role: "operator" };
const owner: SessionUser = { username: "owner1", role: "app_owner" };
const admin: SessionUser = { username: "admin1", role: "platform_admin" };

async function renderApp(path: string, user: SessionUser | null): Promise<void> {
  vi.mocked(api.fetchMe).mockResolvedValue(user);
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  if (path === "/login" || !user) {
    await waitFor(() => expect(screen.getByTestId("app-shell")).toBeTruthy());
    return;
  }
  await waitFor(() =>
    expect(screen.getByRole("navigation", { name: "主要分區" })).toBeTruthy(),
  );
}

function tabs(): HTMLElement {
  return screen.getByRole("navigation", { name: "主要分區" });
}

function tree(): HTMLElement {
  return screen.getByRole("navigation", { name: "本區頁面" });
}

beforeEach(() => {
  vi.spyOn(api, "fetchMe").mockResolvedValue(null);
  vi.spyOn(api, "setUnauthorizedHandler").mockImplementation(() => {});
  vi.spyOn(api, "apiGet").mockResolvedValue({ status: 200, data: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AppChrome 登入頁不掛外框", () => {
  it("沒有頁籤、側欄、詢問 AI 與底部留白", async () => {
    await renderApp("/login", null);
    expect(screen.queryByRole("navigation", { name: "主要分區" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "本區頁面" })).toBeNull();
    expect(screen.queryByTestId("ai-launch")).toBeNull();
    expect(screen.queryByTestId("ai-launch-spacer")).toBeNull();
    expect(screen.getByTestId("theme-slot-login")).toBeTruthy();
  });
});

describe("AppChrome 儀表板可見性", () => {
  it("operator 在儀表板頁籤與監看側欄為現行；不含 AI 項目", async () => {
    await renderApp("/dashboard", op);
    expect(within(tabs()).getByRole("link", { name: "儀表板" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      within(tree()).getByRole("link", { name: titleFor("/dashboard") }).getAttribute("aria-current"),
    ).toBe("page");
    expect(within(tree()).queryByRole("link", { name: "AI 判斷" })).toBeNull();
    expect(within(tree()).queryByRole("link", { name: "威脅紀錄" })).toBeNull();
  });

  it("platform_admin 與 app_owner 看不見儀表板頁籤，直接進入為無權限", async () => {
    await renderApp("/dashboard", admin);
    expect(within(tabs()).queryByRole("link", { name: "儀表板" })).toBeNull();
    expect(screen.getByTestId("no-permission")).toBeTruthy();
    cleanup();
    await renderApp("/dashboard", owner);
    expect(within(tabs()).queryByRole("link", { name: "儀表板" })).toBeNull();
    expect(screen.getByTestId("no-permission")).toBeTruthy();
  });
});

describe("AppChrome 頁籤與側欄來自路由", () => {
  it("operator 在待判斷可見值勤頁籤，現行項目為待判斷", async () => {
    await renderApp("/judgments", op);
    expect(within(tabs()).getByRole("link", { name: "判斷紀錄" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(within(tabs()).getByRole("link", { name: "封鎖與審核" })).toBeTruthy();
    expect(within(tabs()).queryByRole("link", { name: "告警與健康" })).toBeNull();
    expect(within(tabs()).queryByRole("link", { name: "應用" })).toBeNull();
    expect(within(tabs()).getByRole("link", { name: "儀表板" }).getAttribute("aria-current")).toBeNull();
    expect(
      within(tree()).getByRole("link", { name: titleFor("/judgments") }).getAttribute("aria-current"),
    ).toBe("page");
    expect(within(tree()).getByRole("link", { name: titleFor("/judgments/history") })).toBeTruthy();
    expect(within(tree()).getByRole("link", { name: titleFor("/constraints") })).toBeTruthy();
    expect(within(tree()).queryByRole("link", { name: titleFor("/whitelist") })).toBeNull();
  });


  it("platform_admin 在健康頁只見管理面；app_owner 只見應用", async () => {
    await renderApp("/health", admin);
    expect(within(tabs()).getByRole("link", { name: "告警與健康" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(within(tabs()).getByRole("link", { name: "封鎖與審核" })).toBeTruthy();
    expect(within(tabs()).queryByRole("link", { name: "判斷紀錄" })).toBeNull();
    expect(within(tabs()).queryByRole("link", { name: "儀表板" })).toBeNull();
    expect(
      within(tree()).getByRole("link", { name: titleFor("/health") }).getAttribute("aria-current"),
    ).toBe("page");
    expect(within(tree()).queryByRole("link", { name: titleFor("/judgments") })).toBeNull();
    cleanup();
    await renderApp("/apps/new", owner);
    expect(within(tabs()).getByRole("link", { name: "應用" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(within(tree()).getByRole("link", { name: titleFor("/apps/new") })).toBeTruthy();
    expect(within(tabs()).queryByRole("link", { name: "封鎖與審核" })).toBeNull();
  });

  it("保留主題切換槽位；點詢問 AI 只顯示尚未啟用並有底部留白", async () => {
    await renderApp("/judgments", op);
    expect(screen.getByTestId("theme-slot-sidebar")).toBeTruthy();
    expect(screen.getByTestId("theme-slot-topbar")).toBeTruthy();
    expect(screen.getByTestId("ai-launch-spacer")).toBeTruthy();
    const btn = screen.getByTestId("ai-launch");
    expect(btn.textContent).toMatch(/詢問 AI/);
    expect(screen.queryByTestId("ai-launch-status")).toBeNull();
    await userEvent.click(btn);
    expect(screen.getByTestId("ai-launch-status").textContent).toBe("AI 尚未啟用");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("頂欄模式為尚未接線占位，只顯示使用者名稱", async () => {
    await renderApp("/judgments", op);
    expect(screen.getByText("模式：尚未接線")).toBeTruthy();
    expect(screen.queryByText("只接收鏡像流量")).toBeNull();
    expect(screen.queryByRole("button", { name: "模式：尚未接線" })).toBeNull();
    expect(screen.queryByRole("link", { name: "模式：尚未接線" })).toBeNull();
    expect(screen.getByText("operator1")).toBeTruthy();
    expect(screen.queryByText(/值勤中/)).toBeNull();
  });
});
