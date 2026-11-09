import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThresholdEditor } from "./ThresholdEditor";
import { ThresholdReadonly } from "./ThresholdReadonly";

afterEach(() => {
  cleanup();
});

describe("ThresholdEditor（白名單頁可編輯門檻）", () => {
  beforeEach(() => {
    // no-op
  });

  it("顯示目前 case／auto 並可提交合法值；每次變更顯示稽核提示", async () => {
    const user = userEvent.setup();
    const saves: { case: number; auto: number }[] = [];
    render(
      <ThresholdEditor
        value={{ case: 0.5, auto: 0.9 }}
        onSave={(t) => {
          saves.push(t);
          return { ok: true as const, notice: "已更新門檻（已寫入稽核）" };
        }}
      />,
    );
    expect(screen.getByTestId("threshold-editor")).toBeTruthy();
    const caseInput = screen.getByTestId("threshold-case") as HTMLInputElement;
    const autoInput = screen.getByTestId("threshold-auto") as HTMLInputElement;
    expect(caseInput.value).toBe("0.5");
    expect(autoInput.value).toBe("0.9");
    await user.clear(caseInput);
    await user.type(caseInput, "0.4");
    await user.clear(autoInput);
    await user.type(autoInput, "0.85");
    await user.click(screen.getByTestId("threshold-save"));
    expect(saves).toEqual([{ case: 0.4, auto: 0.85 }]);
    expect(screen.getByTestId("threshold-audit-notice").textContent).toMatch(
      /稽核/,
    );
  });

  it("非法值顯示錯誤、不呼叫 onSave", async () => {
    const user = userEvent.setup();
    const saves: unknown[] = [];
    render(
      <ThresholdEditor
        value={{ case: 0.5, auto: 0.9 }}
        onSave={(t) => {
          saves.push(t);
          return { ok: true as const, notice: "ok" };
        }}
      />,
    );
    const caseInput = screen.getByTestId("threshold-case");
    const autoInput = screen.getByTestId("threshold-auto");
    await user.clear(caseInput);
    await user.type(caseInput, "0.95");
    await user.clear(autoInput);
    await user.type(autoInput, "0.5");
    await user.click(screen.getByTestId("threshold-save"));
    expect(saves).toEqual([]);
    expect(screen.getByTestId("threshold-error").textContent).toMatch(/0/);
  });
});

describe("ThresholdReadonly（審核頁唯讀門檻）", () => {
  it("顯示目前 case／auto，無編輯控件", () => {
    render(<ThresholdReadonly value={{ case: 0.5, auto: 0.9 }} />);
    const el = screen.getByTestId("threshold-readonly");
    expect(el.textContent).toMatch(/0\.5/);
    expect(el.textContent).toMatch(/0\.9/);
    expect(screen.queryByTestId("threshold-save")).toBeNull();
    expect(screen.queryByTestId("threshold-case")).toBeNull();
  });
});
