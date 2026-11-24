import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { username: "admin1", role: "platform_admin" } }),
}));

vi.mock("../review/reviewSource", () => ({
  reviewSource: {
    isDemo: vi.fn(() => false),
    isUnreachable: vi.fn(() => false),
    listPending: vi.fn(),
    listActive: vi.fn(),
    listWhitelist: vi.fn(),
    getThresholds: vi.fn(),
    getAutoList: vi.fn(),
    putAutoList: vi.fn(),
  },
}));

import { reviewSource } from "../review/reviewSource";
import { BlacklistListedPage } from "./BlacklistListedPage";
import { BlacklistReviewPage } from "./BlacklistReviewPage";
import { DashboardPage } from "./DashboardPage";
import { WhitelistPage } from "./WhitelistPage";

const isDemo = vi.mocked(reviewSource.isDemo);
const listPending = vi.mocked(reviewSource.listPending);
const listActive = vi.mocked(reviewSource.listActive);
const listWhitelist = vi.mocked(reviewSource.listWhitelist);
const getThresholds = vi.mocked(reviewSource.getThresholds);
const getAutoList = vi.mocked(reviewSource.getAutoList);

beforeEach(() => {
  isDemo.mockReturnValue(false);
  listPending.mockResolvedValue({ ok: true, value: [] });
  listActive.mockResolvedValue({ ok: true, value: [] });
  listWhitelist.mockResolvedValue({ ok: true, value: [] });
  getThresholds.mockResolvedValue({ ok: true, value: { case: 0.5, auto: 0.9 } });
  getAutoList.mockResolvedValue({ ok: true, value: { enabled: false } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function ready(): Promise<void> {
  await waitFor(() => expect(listPending.mock.calls.length + listActive.mock.calls.length + listWhitelist.mock.calls.length).toBeGreaterThan(0));
}

describe("示範資料標記：各 reviewSource 頁", () => {
  it("真實模式四頁都不出現示範資料", async () => {
    isDemo.mockReturnValue(false);
    render(<DashboardPage />);
    render(<BlacklistReviewPage />);
    render(<BlacklistListedPage />);
    render(<WhitelistPage />);
    await ready();
    expect(screen.queryAllByTestId("demo-data-marker")).toEqual([]);
    expect(screen.queryByText("示範資料")).toBeNull();
  });

  it("示範模式四頁都出現示範資料", async () => {
    isDemo.mockReturnValue(true);
    render(<DashboardPage />);
    render(<BlacklistReviewPage />);
    render(<BlacklistListedPage />);
    render(<WhitelistPage />);
    await ready();
    const marks = screen.getAllByTestId("demo-data-marker");
    expect(marks).toHaveLength(4);
    expect(marks.every((el) => el.textContent === "示範資料")).toBe(true);
  });
});
