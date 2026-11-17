import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AdminApiErr } from "../review/adminApi";
import type { PendingCandidate } from "../review/types";

vi.mock("../auth", () => ({
  useAuth: () => ({ user: { username: "operator1", role: "operator" } }),
}));

vi.mock("../review/reviewSource", () => ({
  reviewSource: {
    listPending: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    isUnreachable: vi.fn(() => false),
    isDemo: vi.fn(() => false),
  },
}));

import { reviewSource } from "../review/reviewSource";
import { BlacklistReviewPage } from "./BlacklistReviewPage";

const listPending = vi.mocked(reviewSource.listPending);
const approve = vi.mocked(reviewSource.approve);
const reject = vi.mocked(reviewSource.reject);
const isUnreachable = vi.mocked(reviewSource.isUnreachable);

const CASE = "11111111-1111-4111-8111-111111111111";

function item(partial: Partial<PendingCandidate> = {}): PendingCandidate {
  return {
    ip: "203.0.113.18",
    confidence: 0.87,
    case_id: CASE,
    created_at: "2026-11-16T06:51:02Z",
    hit_count: 3,
    last_hit_at: "2026-11-16T06:51:02Z",
    ...partial,
  };
}

function apiErr(code: AdminApiErr["code"], message: string, status: number): AdminApiErr {
  return { ok: false, status, code, message };
}

const NOW = "2026-11-16T07:00:00Z";

async function renderReview(): Promise<void> {
  render(<BlacklistReviewPage nowIso={NOW} />);
  await waitFor(() => expect(listPending).toHaveBeenCalled());
}

beforeEach(() => {
  listPending.mockResolvedValue({ ok: true, value: [] });
  approve.mockResolvedValue({ ok: true, value: undefined as never });
  reject.mockResolvedValue({ ok: true, value: undefined });
  isUnreachable.mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BlacklistReviewPage 待審列", () => {
  it("空清單顯示繁中空狀態，標題仍為黑名單審核", async () => {
    await renderReview();
    expect(screen.getByRole("heading", { name: "黑名單審核" })).toBeTruthy();
    expect(screen.getByTestId("empty-state").textContent).toMatch(/尚無待審黑名單/);
    expect(screen.queryByTestId("reject-reason-" + CASE)).toBeNull();
  });

  it("列出真實欄位，缺資料與 AI 版位為占位，不顯示預設門檻數字", async () => {
    listPending.mockResolvedValue({ ok: true, value: [item()] });
    await renderReview();
    const row = screen.getByTestId("blacklist-pending-list").textContent ?? "";
    expect(row).toContain(CASE);
    expect(row).toContain("203.0.113.18");
    expect(row).toContain("0.87");
    expect(row).toContain("14:51:02");
    expect(screen.getByTestId(`hits-${CASE}`).textContent).toMatch(/命中 3 次/);
    expect(screen.getAllByText("AI 尚未啟用").length).toBeGreaterThan(0);
    expect(screen.getAllByText("尚未接線").length).toBeGreaterThan(0);
    expect(screen.queryByText("0.50")).toBeNull();
    expect(screen.queryByText("退回理由")).toBeNull();
    expect(screen.getByTestId(`approve-${CASE}`).textContent).toMatch(/核准/);
    expect(screen.getByTestId(`reject-${CASE}`).textContent).toMatch(/駁回/);
    expect(screen.getByText(/1 件待審/)).toBeTruthy();
  });
});

describe("BlacklistReviewPage 核准與退回", () => {
  it("核准呼叫 API 且重整列表", async () => {
    listPending
      .mockResolvedValueOnce({ ok: true, value: [item()] })
      .mockResolvedValueOnce({ ok: true, value: [] });
    approve.mockResolvedValue({
      ok: true,
      value: {
        entry_id: "22222222-2222-4222-8222-222222222222",
        ip: "203.0.113.18",
        source: "manual",
        confidence: 0.87,
        case_id: CASE,
        created_at: "2026-11-16T06:51:02Z",
        expires_at: "2026-11-17T08:00:00Z",
        approved_by: "operator1",
        approved_at: "2026-11-16T08:00:00Z",
        revoked_at: null,
      },
    });
    await renderReview();
    fireEvent.click(screen.getByTestId(`approve-${CASE}`));
    await waitFor(() => expect(approve).toHaveBeenCalledWith(CASE));
    await waitFor(() => expect(screen.getByTestId("review-status").textContent).toBe("已核准"));
    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeTruthy());
    expect(listPending).toHaveBeenCalledTimes(2);
  });

  it("駁回不送理由；409 顯示後端原文並重整列表", async () => {
    listPending
      .mockResolvedValueOnce({ ok: true, value: [item()] })
      .mockResolvedValueOnce({ ok: true, value: [] });
    reject.mockResolvedValue(apiErr("conflict", "已自動上榜", 409));
    await renderReview();
    fireEvent.click(screen.getByTestId(`reject-${CASE}`));
    await waitFor(() => expect(reject).toHaveBeenCalledWith(CASE));
    expect(reject.mock.calls[0]?.length).toBe(1);
    await waitFor(() =>
      expect(screen.getByTestId("review-status").textContent).toBe("已自動上榜"),
    );
    expect(listPending).toHaveBeenCalledTimes(2);
  });
});

describe("BlacklistReviewPage 錯誤狀態", () => {
  it("401 與未知 4xx 顯示後端訊息，不拿 demo 頂替", async () => {
    listPending.mockResolvedValue(apiErr("unauthorized", "未登入", 401));
    await renderReview();
    await waitFor(() => expect(screen.getByTestId("review-status").textContent).toBe("未登入"));
    expect(screen.queryByTestId("blacklist-pending-list")).toBeNull();

    cleanup();
    listPending.mockResolvedValue({ ok: true, value: [item()] });
    approve.mockResolvedValue(apiErr("client_error", "已達每小時上限", 429));
    await renderReview();
    fireEvent.click(screen.getByTestId(`approve-${CASE}`));
    await waitFor(() =>
      expect(screen.getByTestId("review-status").textContent).toBe("已達每小時上限"),
    );
  });

  it("無法連線時顯示錯誤，不列出待審", async () => {
    isUnreachable.mockReturnValue(true);
    listPending.mockResolvedValue(
      apiErr("backend_unreachable", "後端無法連線，請稍後再試", 0),
    );
    await renderReview();
    expect(screen.getByTestId("backend-unreachable").textContent).toMatch(/後端無法連線/);
    expect(screen.queryByTestId("blacklist-pending-list")).toBeNull();
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });
});
