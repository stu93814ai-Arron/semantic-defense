import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("./reviewSource", () => ({
  reviewSource: {
    getThresholds: vi.fn(),
    updateThresholds: vi.fn(),
    getAutoList: vi.fn(),
    putAutoList: vi.fn(),
  },
}));

import { reviewSource } from "./reviewSource";
import { WhitelistThresholdSection } from "./WhitelistThresholdSection";

const getThresholds = vi.mocked(reviewSource.getThresholds);
const getAutoList = vi.mocked(reviewSource.getAutoList);

beforeEach(() => {
  getThresholds.mockResolvedValue({ ok: true, value: { case: 0.5, auto: 0.9 } });
  getAutoList.mockResolvedValue({ ok: true, value: { enabled: false } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WhitelistThresholdSection：判定設定區塊", () => {
  it("標題為「判定設定」，platform_admin 在區塊內看到自動上榜開關與門檻", async () => {
    render(<WhitelistThresholdSection role="platform_admin" actorId="admin1" onChanged={() => {}} />);
    const block = screen.getByRole("region", { name: "判定設定" });
    expect(within(block).getByRole("heading", { level: 2 }).textContent).toBe("判定設定");
    expect(await within(block).findByRole("switch")).toBeTruthy();
    expect(within(block).getByTestId("threshold-editor")).toBeTruthy();
    expect(getAutoList).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { level: 2, name: "成案／自動上榜門檻" })).toBeNull();
  });

  it.each(["operator", "app_owner", undefined] as const)(
    "角色 %s：不顯示開關、不呼叫 GET，門檻照常",
    (role) => {
      render(<WhitelistThresholdSection role={role} actorId="u1" onChanged={() => {}} />);
      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.queryByTestId("auto-list")).toBeNull();
      expect(getAutoList).not.toHaveBeenCalled();
      expect(screen.getByTestId("threshold-editor")).toBeTruthy();
    },
  );
});
