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
