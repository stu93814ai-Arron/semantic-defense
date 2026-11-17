import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { titleFor } from "../roles";
import { isJudgmentCaseId } from "../routing/safeSegment";
import { JudgmentDetailPage } from "./JudgmentDetailPage";

vi.mock("../api", () => ({
  apiGet: vi.fn(),
}));

import { apiGet } from "../api";

const mockedGet = vi.mocked(apiGet);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(path = "/judgments/case-fixture-1"): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/judgments/:caseId" element={<JudgmentDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function stub(status: number, error?: string): void {
  mockedGet.mockResolvedValue({ status, data: null, error });
}

describe("JudgmentDetailPage 標題與查詢", () => {
  it("h1 使用 titleFor(\"/judgments/:id\")，並以編碼後路徑查詢合法 caseId", async () => {
    const caseId = "case-fixture-1";
    stub(404, "查無案件");
    renderPage(`/judgments/${caseId}`);
    expect(screen.getByRole("heading", { level: 1, name: titleFor("/judgments/:id") })).toBeTruthy();
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(mockedGet).toHaveBeenCalledWith(`/api/judgments/${encodeURIComponent(caseId)}`);
  });

  it("404 顯示尚無此案件資料空狀態", async () => {
    stub(404, "查無案件");
    renderPage();
    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeTruthy());
    expect(screen.getByTestId("empty-state").textContent).toMatch(/尚無此案件資料/);
    expect(screen.getByTestId("empty-state").textContent).toMatch(/尚無|沒有|尚不|暫無/);
  });
});


describe("JudgmentDetailPage 案件編號驗證", () => {
  it("不合法或超長 caseId 不發請求、顯示空狀態，且不把原文寫入眉題", async () => {
    const cases = ["case/id?x=1", "a".repeat(65), "case id", "../etc", "id<script>"];
    for (const caseId of cases) {
      cleanup();
      vi.clearAllMocks();
      stub(404, "查無案件");
      renderPage(`/judgments/${encodeURIComponent(caseId)}`);
      await waitFor(() => expect(screen.getByTestId("empty-state")).toBeTruthy());
      expect(screen.getByTestId("empty-state").textContent).toMatch(/尚無此案件資料/);
      expect(mockedGet).not.toHaveBeenCalled();
      const page = (document.querySelector("main.case-detail") as HTMLElement | null)?.textContent ?? "";
      expect(page).toMatch(/^\s*待判斷/);
      expect(page).not.toContain(caseId);
      expect(page).not.toMatch(/待判斷 \/ /);
    }
  });

  it("isJudgmentCaseId 拒收「.」「..」「.x」，合法編號仍通過", () => {
    expect(isJudgmentCaseId(".")).toBe(false);
    expect(isJudgmentCaseId("..")).toBe(false);
    expect(isJudgmentCaseId(".x")).toBe(false);
    expect(isJudgmentCaseId("case-fixture-1")).toBe(true);
    expect(isJudgmentCaseId("a")).toBe(true);
  });

  it("「.」「..」「.x」不發請求、顯示尚無此案件資料，且不把原文寫入頁面", async () => {
    for (const caseId of [".", "..", ".x"]) {
      cleanup();
      vi.clearAllMocks();
      stub(404, "查無案件");
      renderPage(`/judgments/${encodeURIComponent(caseId)}`);
      await waitFor(() => expect(screen.getByTestId("empty-state")).toBeTruthy());
      expect(screen.getByTestId("empty-state").textContent).toMatch(/尚無此案件資料/);
      expect(mockedGet).not.toHaveBeenCalled();
      const page = (document.querySelector("main.case-detail") as HTMLElement | null)?.textContent ?? "";
      expect(page).toMatch(/^\s*待判斷/);
      expect(page).not.toContain(caseId);
      expect(page).not.toMatch(/待判斷 \/ /);
    }
  });

  it("case-fixture-1 與 64 字安全字元為合法，會發查詢並可出現在眉題", async () => {
    stub(404, "查無案件");
    renderPage("/judgments/case-fixture-1");
    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));
    expect(mockedGet).toHaveBeenCalledWith("/api/judgments/case-fixture-1");
    expect((document.querySelector("main.case-detail") as HTMLElement).textContent).toMatch(/待判斷 \/ case-fixture-1/);

    cleanup();
    vi.clearAllMocks();
    const allowed = `${"a".repeat(60)}_.:-`;
    expect(allowed).toHaveLength(64);
    stub(404, "查無案件");
    renderPage(`/judgments/${encodeURIComponent(allowed)}`);
    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));
    expect(mockedGet).toHaveBeenCalledWith(`/api/judgments/${encodeURIComponent(allowed)}`);
    const page = (document.querySelector("main.case-detail") as HTMLElement | null)?.textContent ?? "";
    expect(page).toContain(`待判斷 / ${allowed}`);
  });
});

describe("JudgmentDetailPage 錯誤處理", () => {
  it("401 顯示未登入，不顯示空狀態或連線錯誤", async () => {
    stub(401);
    renderPage();
    await waitFor(() => expect(screen.getByText("未登入")).toBeTruthy());
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.queryByText("後端無法連線，請稍後再試")).toBeNull();
  });

  it("403 顯示權限不足，不顯示空狀態或連線錯誤", async () => {
    stub(403);
    renderPage();
    await waitFor(() => expect(screen.getByText("權限不足")).toBeTruthy());
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.queryByText("後端無法連線，請稍後再試")).toBeNull();
  });

  it("5xx 與連線失敗顯示固定前端文案，不採用後端本文", async () => {
    stub(500, "internal secret stack");
    renderPage();
    await waitFor(() => expect(screen.getByText("後端無法連線，請稍後再試")).toBeTruthy());
    expect(screen.queryByText("internal secret stack")).toBeNull();
    expect(screen.queryByTestId("empty-state")).toBeNull();

    cleanup();
    mockedGet.mockRejectedValueOnce(new Error("network"));
    renderPage();
    await waitFor(() => expect(screen.getByText("後端無法連線，請稍後再試")).toBeTruthy());
  });

  it("400／409／429 的後端字串訊息截斷至約 200 字", async () => {
    const long = "錯".repeat(250);
    for (const status of [400, 409, 429]) {
      cleanup();
      stub(status, long);
      renderPage();
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("錯".repeat(200)));
      expect(screen.getByRole("alert").textContent?.length).toBe(200);
      expect(screen.queryByTestId("empty-state")).toBeNull();
    }
  });

  it("非字串後端訊息改用固定後備文案，不顯示物件內容", async () => {
    mockedGet.mockResolvedValue({
      status: 400,
      data: null,
      error: { code: "bad" } as unknown as string,
    });
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("請求失敗"));
    expect(screen.queryByText(/object|bad/i)).toBeNull();
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });
});

describe("JudgmentDetailPage 版面占位", () => {
  it("連線事實欄位皆為尚未接線，AI 僅顯示尚未啟用，不含示範數字或產品宣稱", async () => {
    stub(404, "查無案件");
    renderPage();
    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeTruthy());
    const facts = screen.getByTestId("case-facts").textContent ?? "";
    for (const label of ["來源", "目的端", "時間窗", "連線數", "間隔", "上傳／下載", "目的變化"]) {
      expect(facts).toContain(label);
    }
    expect(facts).toMatch(/尚未接線/);
    expect(screen.getByTestId("case-ai").textContent).toMatch(/AI 尚未啟用/);
    const page = (document.querySelector("main.case-detail") as HTMLElement | null)?.textContent ?? "";
    expect(page).toMatch(/待判斷 \/ case-fixture-1/);
    expect(page).not.toMatch(/只接收鏡像流量|以 AI 偵測|所有操作|不解密|C-2416|短時間輪換|Llama|0\.87|示範資料/);
    expect(screen.queryByRole("button", { name: /核准|駁回/ })).toBeNull();
  });

  it("2xx 仍不解析未知欄位，維持尚未接線與 AI 尚未啟用", async () => {
    mockedGet.mockResolvedValue({
      status: 200,
      data: { title: "短時間輪換手法試探", confidence: 0.87 },
    });
    renderPage("/judgments/abc");
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.getByTestId("case-facts").textContent).toMatch(/尚未接線/);
    expect(screen.getByTestId("case-ai").textContent).toMatch(/AI 尚未啟用/);
    const page = (document.querySelector("main.case-detail") as HTMLElement | null)?.textContent ?? "";
    expect(page).not.toContain("短時間輪換手法試探");
    expect(page).not.toContain("0.87");
  });
});

function settledMainHtml(): string {
  const main = document.querySelector("main.case-detail") as HTMLElement | null;
  if (!main) throw new Error("missing main.case-detail");
  const clone = main.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-testid="empty-state"]').forEach((el) => el.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

function mainChildFingerprint(): string[] {
  const main = document.querySelector("main.case-detail") as HTMLElement | null;
  if (!main) throw new Error("missing main.case-detail");
  return Array.from(main.children)
    .filter((el) => el.getAttribute("data-testid") !== "empty-state")
    .map((el) => `${el.tagName}:${el.className}`);
}

describe("JudgmentDetailPage 2xx 不顯示判決或狀態", () => {
  it("2xx 不渲染 StatusBanner，無 alert／status，頭卡與 404 除去空狀態後完全相同", async () => {
    const path = "/judgments/abc";

    stub(404, "查無案件");
    renderPage(path);
    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeTruthy());
    const emptyText = settledMainHtml();
    const emptyFingerprint = mainChildFingerprint();

    cleanup();
    vi.clearAllMocks();
    mockedGet.mockResolvedValue({
      status: 200,
      data: {
        verdict: "block",
        status: "pending",
        decision: "核准",
        state: "待審",
        confidence: 0.87,
        label: "已判定：惡意",
      },
    });
    renderPage(path);
    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalled();
      expect(screen.queryByText("載入中…")).toBeNull();
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByTestId("empty-state")).toBeNull();
    expect(screen.queryByText("載入中…")).toBeNull();
    // StatusBanner 對 2xx 必須不渲染任何節點：main 子節點只剩眉題、標題與內容列
    expect(mainChildFingerprint()).toEqual(["P:eyebrow", "H1:", "DIV:case-detail__row"]);
    expect(mainChildFingerprint()).toEqual(emptyFingerprint);
    expect(settledMainHtml()).toBe(emptyText);
  });
});
