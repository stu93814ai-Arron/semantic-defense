import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("403 顯示錯誤狀態，不顯示空狀態", async () => {
    mockedGet.mockResolvedValue({
      status: 403,
      data: {
        status: "ok",
        alerts: { pending: 0, failed: 0, delivered_1h: 0, undelivered: 0, last_failed_at: null },
      },
    });
    render(<HealthPage />);
    await waitFor(() => expect(screen.getByTestId("backend-unreachable")).toBeTruthy());
    expect(screen.getByTestId("backend-unreachable").textContent).toMatch(/無法連線|錯誤|無法載入/);
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.queryByText("載入中…")).toBeNull();
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
