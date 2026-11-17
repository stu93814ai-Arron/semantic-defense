import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { titleFor } from "../roles";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { HealthPage } from "./HealthPage";

vi.mock("../api", () => ({
  apiGet: vi.fn(),
}));

import { apiGet } from "../api";

const mockedGet = vi.mocked(apiGet);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("HealthPage（告警計數；待 B 組領航員核准）", () => {
  it("顯示未送達與重試用盡計數，不渲染 URL 或 host", async () => {
    mockedGet.mockResolvedValue({
      status: 200,
      data: {
        status: "ok",
        alerts: { pending: 2, failed: 1, delivered_1h: 3, undelivered: 3, last_failed_at: 1_700_000_000_000 },
      },
    });
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByTestId("alert-health")).toBeTruthy());
    const text = screen.getByTestId("alert-health").textContent ?? "";
    expect(text).toContain("2");
    expect(text).toContain("重試用盡");
    expect(text).not.toMatch(/https?:|example\.|password/i);
  });

  it("計數皆為零時顯示繁中空狀態", async () => {
    mockedGet.mockResolvedValue({
      status: 200,
      data: {
        status: "ok",
        alerts: { pending: 0, failed: 0, delivered_1h: 0, undelivered: 0, last_failed_at: null },
      },
    });
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeTruthy());
    expect(screen.getByTestId("empty-state").textContent).toMatch(/尚無|沒有|尚不|暫無/);
  });
});

describe("HealthPage 錯誤與時間格式（待 B 組領航員核准）", () => {
  it("403 顯示「權限不足」，不顯示空狀態或連線錯誤", async () => {
    mockedGet.mockResolvedValue({
      status: 403,
      data: {
        status: "ok",
        alerts: { pending: 0, failed: 0, delivered_1h: 0, undelivered: 0, last_failed_at: null },
      },
    });
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByText("權限不足")).toBeTruthy());
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.queryByTestId("backend-unreachable")).toBeNull();
    expect(screen.queryByText("載入中…")).toBeNull();
  });

  it("401 顯示「未登入」，不顯示空狀態或連線錯誤", async () => {
    mockedGet.mockResolvedValue({ status: 401, data: null });
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByText("未登入")).toBeTruthy());
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.queryByTestId("backend-unreachable")).toBeNull();
  });

  it("500 顯示錯誤狀態，不顯示空狀態", async () => {
    mockedGet.mockResolvedValue({
      status: 500,
      data: null,
    });
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByTestId("backend-unreachable")).toBeTruthy());
    expect(screen.getByTestId("backend-unreachable").textContent).toMatch(/無法連線|錯誤|無法載入/);
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.queryByText("載入中…")).toBeNull();
  });

  it("alerts 欄位型別不正確時顯示格式錯誤，不顯示空狀態", async () => {
    mockedGet.mockResolvedValue({
      status: 200,
      data: {
        status: "ok",
        alerts: { pending: "x", failed: 0, delivered_1h: 0, undelivered: 0, last_failed_at: null },
      },
    });
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByTestId("invalid-response")).toBeTruthy());
    expect(screen.getByTestId("invalid-response").textContent).toMatch(/格式/);
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.queryByTestId("alert-health")).toBeNull();
  });

  it("last_failed_at 顯示為格式化時間，不是原始數字", async () => {
    const at = 1_700_000_000_000;
    mockedGet.mockResolvedValue({
      status: 200,
      data: {
        status: "ok",
        alerts: { pending: 0, failed: 1, delivered_1h: 0, undelivered: 1, last_failed_at: at },
      },
    });
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByTestId("alert-health")).toBeTruthy());
    const text = screen.getByTestId("alert-health").textContent ?? "";
    const formatted = new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei", dateStyle: "medium", timeStyle: "medium",
    }).format(new Date(at));
    expect(text).toContain(formatted);
    expect(text).not.toContain(String(at));
  });
});

const ZERO_ALERTS = {
  pending: 0, failed: 0, delivered_1h: 0, undelivered: 0, last_failed_at: null,
};

function okHealth(extra: Record<string, unknown> = {}) {
  return {
    status: 200,
    data: { status: "ok", alerts: ZERO_ALERTS, ...extra },
  };
}

describe("HealthPage 版面與判定計數", () => {
  it("h1 使用 titleFor(\"/health\")，不用寫死文案", async () => {
    mockedGet.mockResolvedValue(okHealth());
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeTruthy());
    expect(screen.getByRole("heading", { level: 1, name: titleFor("/health") })).toBeTruthy();
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "HealthPage.tsx"),
      "utf8",
    );
    expect(src).toMatch(/titleFor\("\/health"\)/);
    expect(src).not.toMatch(/<h1>平台健康<\/h1>/);
  });

  it("有 judge 時顯示真實計數；缺欄位與 AI 為占位，不發明數字", async () => {
    mockedGet.mockResolvedValue(okHealth({
      judge: { tick_fail_streak: 2, cursor_lag_seconds: 15, stale_pending_total: 3 },
    }));
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByTestId("health-status-grid")).toBeTruthy());
    const grid = screen.getByTestId("health-status-grid").textContent ?? "";
    expect(grid).toMatch(/判定程序/);
    expect(grid).toContain("2");
    expect(grid).toContain("15");
    expect(grid).toContain("3");
    expect(grid).toMatch(/連續失敗|游標落後|過期待審/);
    expect(grid).toMatch(/鏡像接收/);
    expect(grid).toMatch(/尚未接線/);
    expect(grid).toMatch(/模型連線/);
    expect(grid).toMatch(/AI 尚未啟用/);
    expect(grid).toMatch(/EDL 發布/);
    expect(grid).toMatch(/資料庫/);
    expect(grid).toMatch(/簽章金鑰/);
    expect(grid).toMatch(/運作模式/);
    expect(grid).toMatch(/控制 API/);
    expect(grid).toMatch(/可連線/);
    expect(grid).not.toMatch(/4\.8|只接收鏡像流量/);
    expect(screen.getByTestId("health-alert-feed").textContent).toMatch(/尚未接線/);
    expect(screen.queryByTestId("demo-data-marker")).toBeNull();
  });

  it("沒有 judge 時判定程序為尚未接線，告警計數仍顯示", async () => {
    mockedGet.mockResolvedValue(okHealth());
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByTestId("alert-health")).toBeTruthy());
    const grid = screen.getByTestId("health-status-grid").textContent ?? "";
    expect(grid).toMatch(/判定程序/);
    expect(grid).toMatch(/尚未接線/);
    expect(grid).not.toMatch(/連續失敗/);
    expect(screen.getByTestId("empty-state").textContent).toMatch(/尚無未送達告警/);
  });
});


function rawOk(data: unknown) {
  return { status: 200, data } as Awaited<ReturnType<typeof apiGet>>;
}

describe("HealthPage 控制 API 狀態、未送達橫幅與判定守衛", () => {
  it("控制 API 僅在 status 為短字串時加上括號，物件不導致渲染崩潰", async () => {
    mockedGet.mockResolvedValue(okHealth());
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByTestId("health-status-grid")).toBeTruthy());
    expect(screen.getByTestId("health-status-grid").textContent).toContain("健康端點可連線（ok）");

    cleanup();
    mockedGet.mockResolvedValue(rawOk({ status: { code: "ok" }, alerts: ZERO_ALERTS }));
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByTestId("health-status-grid")).toBeTruthy());
    let text = screen.getByTestId("health-status-grid").textContent ?? "";
    expect(text).toContain("健康端點可連線");
    expect(text).not.toMatch(/健康端點可連線（/);
    expect(text).not.toContain("[object Object]");

    cleanup();
    mockedGet.mockResolvedValue(rawOk({ status: "x".repeat(33), alerts: ZERO_ALERTS }));
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByTestId("health-status-grid")).toBeTruthy());
    text = screen.getByTestId("health-status-grid").textContent ?? "";
    expect(text).toContain("健康端點可連線");
    expect(text).not.toMatch(/健康端點可連線（/);
    expect(text).not.toContain("x".repeat(33));
  });

  it("未送達橫幅僅在 undelivered > 0 時顯示，且 role 為 status", async () => {
    mockedGet.mockResolvedValue(rawOk({
      status: "ok",
      alerts: { pending: 0, failed: 0, delivered_1h: 0, undelivered: 2, last_failed_at: null },
    }));
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(screen.getByRole("status").textContent).toBe("未送達");

    cleanup();
    mockedGet.mockResolvedValue(okHealth());
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByTestId("alert-health")).toBeTruthy());
    expect(screen.queryByRole("status")).toBeNull();

    cleanup();
    mockedGet.mockResolvedValue(rawOk({
      status: "ok",
      alerts: { pending: 0, failed: 0, delivered_1h: 0, last_failed_at: null },
    }));
    render(<HealthPage />);
    await waitFor(() => expect(screen.queryByText("載入中…")).toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("judge 任一欄位為字串、NaN 或缺漏時判定程序顯示尚未接線", async () => {
    const judges: unknown[] = [
      { tick_fail_streak: "2", cursor_lag_seconds: 15, stale_pending_total: 3 },
      { tick_fail_streak: Number.NaN, cursor_lag_seconds: 15, stale_pending_total: 3 },
      { cursor_lag_seconds: 15, stale_pending_total: 3 },
      { tick_fail_streak: 2, cursor_lag_seconds: "15", stale_pending_total: 3 },
      { tick_fail_streak: 2, cursor_lag_seconds: Number.NaN, stale_pending_total: 3 },
      { tick_fail_streak: 2, stale_pending_total: 3 },
      { tick_fail_streak: 2, cursor_lag_seconds: 15, stale_pending_total: "3" },
      { tick_fail_streak: 2, cursor_lag_seconds: 15, stale_pending_total: Number.NaN },
      { tick_fail_streak: 2, cursor_lag_seconds: 15 },
    ];
    for (const judge of judges) {
      cleanup();
      mockedGet.mockResolvedValue(okHealth({ judge }));
      render(<HealthPage />);
      await waitFor(() => expect(screen.getByTestId("health-status-grid")).toBeTruthy());
      const grid = screen.getByTestId("health-status-grid").textContent ?? "";
      expect(grid).toMatch(/判定程序/);
      expect(grid).toMatch(/尚未接線/);
      expect(grid).not.toMatch(/連續失敗|游標落後|過期待審/);
      expect(grid).not.toContain("NaN");
    }
  });
});
