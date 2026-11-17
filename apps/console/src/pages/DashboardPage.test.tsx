import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { AdminApiErr } from "../review/adminApi";
import type { ListedEntry, PendingCandidate } from "../review/types";

vi.mock("../review/reviewSource", () => ({
  reviewSource: {
    listPending: vi.fn(),
    listActive: vi.fn(),
    isDemo: vi.fn(() => false),
  },
}));

vi.mock("../roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../roles")>();
  return { ...actual, titleFor: vi.fn((path: string) => actual.titleFor(path)) };
});

import { titleFor } from "../roles";
import { reviewSource } from "../review/reviewSource";
import { DashboardPage } from "./DashboardPage";

const listPending = vi.mocked(reviewSource.listPending);
const listActive = vi.mocked(reviewSource.listActive);
const NOW = "2026-11-16T16:30:00Z";

function pending(n: number): PendingCandidate {
  return {
    ip: "203.0.113.18",
    confidence: 0.8,
    case_id: `11111111-1111-4111-8111-11111111111${n}`,
    created_at: "2026-11-16T12:00:00Z",
    hit_count: 1,
    last_hit_at: "2026-11-16T12:00:00Z",
  };
}

function listed(partial: Partial<ListedEntry> & Pick<ListedEntry, "entry_id" | "source">): ListedEntry {
  return {
    ip: "198.51.100.1",
    confidence: 0.9,
    case_id: "22222222-2222-4222-8222-222222222222",
    created_at: "2026-11-16T00:00:00Z",
    expires_at: "2026-11-18T00:00:00Z",
    approved_by: partial.source === "auto" ? "system:auto" : "operator1",
    approved_at: "2026-11-16T16:10:00Z",
    revoked_at: null,
    ...partial,
  };
}

function apiErr(code: AdminApiErr["code"], message: string, status = 500): AdminApiErr {
  return { ok: false, status, code, message };
}

async function renderDash(): Promise<void> {
  render(<DashboardPage nowIso={NOW} />);
  await waitFor(() => expect(screen.queryByText("載入中…")).toBeNull());
}

beforeEach(() => {
  listPending.mockResolvedValue({ ok: true, value: [] });
  listActive.mockResolvedValue({ ok: true, value: [] });
  vi.mocked(titleFor).mockImplementation((path: string) =>
    path === "/dashboard" ? "儀表板" : "頁面",
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DashboardPage 真實資料", () => {
  it("顯示待審筆數與生效封鎖彙總，空清單為 0", async () => {
    await renderDash();
    expect(screen.getByRole("heading", { name: "儀表板" })).toBeTruthy();
    expect(screen.getByTestId("dashboard-pending").textContent).toMatch(/待審/);
    expect(screen.getByTestId("dashboard-pending").textContent).toMatch(/\b0\b/);
    const listedBox = screen.getByTestId("dashboard-listed").textContent ?? "";
    expect(listedBox).toMatch(/生效封鎖/);
    expect(listedBox).toMatch(/\b0\b/);
    expect(listPending).toHaveBeenCalledTimes(1);
    expect(listActive).toHaveBeenCalledTimes(1);
  });

  it("依清單彙總今日自動／人工與 24 小時內到期", async () => {
    listPending.mockResolvedValue({ ok: true, value: [pending(1), pending(2)] });
    listActive.mockResolvedValue({
      ok: true,
      value: [
        listed({ entry_id: "a", source: "auto", approved_at: "2026-11-16T16:10:00Z" }),
        listed({ entry_id: "m", source: "manual", approved_at: "2026-11-16T16:20:00Z" }),
        listed({
          entry_id: "soon",
          source: "auto",
          approved_at: "2026-11-15T00:00:00Z",
          expires_at: "2026-11-17T10:00:00Z",
        }),
      ],
    });
    await renderDash();
    expect(screen.getByTestId("dashboard-pending").textContent).toMatch(/\b2\b/);
    const text = screen.getByTestId("dashboard-listed").textContent ?? "";
    expect(text).toMatch(/\b3\b/);
    expect(text).toMatch(/今日自動/);
    expect(text).toMatch(/\b1\b/);
    expect(text).toMatch(/人工/);
    expect(text).toMatch(/24 小時內到期/);
  });
});

describe("DashboardPage 占位與錯誤", () => {
  it("無來源區塊顯示尚未接線，AI 區塊只顯示尚未啟用；模式為尚未接線", async () => {
    await renderDash();
    expect(screen.getByTestId("dashboard-mode").textContent).toBe("模式：尚未接線");
    expect(screen.getByTestId("dashboard-unwired").textContent).toMatch(/尚未接線/);
    expect(screen.getByTestId("dashboard-unwired").textContent).toMatch(/自動上榜|未成案|白名單略過|鏡像流量|系統健康/);
    expect(screen.getByTestId("dashboard-ai").textContent).toBe("AI 尚未啟用");
    expect(screen.queryByTestId("dashboard-ai")?.textContent).not.toMatch(/尚未接線/);
    expect(screen.queryByText("只接收鏡像流量")).toBeNull();
  });

  it("待審或封鎖失敗時只在該區塊顯示錯誤，不回退 demo 數字", async () => {
    listPending.mockResolvedValue(apiErr("unauthorized", "未登入", 401));
    listActive.mockResolvedValue(apiErr("forbidden", "權限不足", 403));
    await renderDash();
    expect(screen.getByTestId("dashboard-pending").textContent).toMatch(/未登入/);
    expect(screen.getByTestId("dashboard-listed").textContent).toMatch(/權限不足/);
    listPending.mockResolvedValue(apiErr("backend_unreachable", "後端無法連線，請稍後再試", 0));
    listActive.mockResolvedValue({ ok: true, value: [] });
    cleanup();
    await renderDash();
    expect(screen.getByTestId("dashboard-pending").textContent).toMatch(/後端無法連線/);
    expect(screen.getByTestId("dashboard-listed").textContent).toMatch(/\b0\b/);
  });
});

describe("DashboardPage 標題與獨立載入", () => {
  it("h1 使用 titleFor(\"/dashboard\")，不用寫死文案", async () => {
    vi.mocked(titleFor).mockReturnValue("標題來自 titleFor");
    await renderDash();
    expect(screen.getByRole("heading", { level: 1, name: "標題來自 titleFor" })).toBeTruthy();
    expect(titleFor).toHaveBeenCalledWith("/dashboard");
  });

  it("待審與封鎖各自載入，互不等待", async () => {
    listPending.mockReturnValue(new Promise(() => undefined));
    listActive.mockResolvedValue({ ok: true, value: [] });
    render(<DashboardPage nowIso={NOW} />);
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-listed").textContent).toMatch(/\b0\b/),
    );
    expect(screen.getByTestId("dashboard-pending").textContent).toMatch(/載入中/);
    expect(screen.getByTestId("dashboard-unwired")).toBeTruthy();
  });
});
