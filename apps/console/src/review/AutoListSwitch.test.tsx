import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AdminApiErr, AdminApiResult } from "./adminApi";
import { AutoListSwitch, type AutoListSource } from "./AutoListSwitch";

afterEach(() => {
  cleanup();
});

type R = AdminApiResult<{ enabled: boolean }>;
const ok = (enabled: boolean): R => ({ ok: true, value: { enabled } });
const err = (status: number, code: AdminApiErr["code"], message: string): AdminApiErr =>
  ({ ok: false, status, code, message });
// 中性 fixture：不抄寫後端實際字串，只驗證原樣傳遞。
const BACKEND_409 = "backend-409-<b>x</b>-fixture"; // 含 HTML：須以純文字呈現
const BACKEND_403 = "backend-403-message-fixture";

function source(gets: R[], puts: R[] = []) {
  const s = {
    getAutoList: vi.fn(async () => gets.shift() ?? ok(false)),
    putAutoList: vi.fn(async (input: { enabled: boolean }) => puts.shift() ?? ok(input.enabled)),
  };
  return s satisfies AutoListSource;
}

describe("AutoListSwitch：僅 platform_admin 顯示", () => {
  it.each(["operator", "app_owner", undefined] as const)("角色 %s 不渲染、不呼叫 GET", (role) => {
    const s = source([ok(true)]);
    const { container } = render(<AutoListSwitch role={role} source={s} />);
    expect(container.innerHTML).toBe("");
    expect(s.getAutoList).not.toHaveBeenCalled();
  });
});

describe("AutoListSwitch：顯示值一律以 GET 為準", () => {
  it("載入中不顯示開或關", () => {
    const s = { getAutoList: () => new Promise<R>(() => {}), putAutoList: vi.fn() };
    render(<AutoListSwitch role="platform_admin" source={s} />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByTestId("auto-list").textContent).not.toMatch(/已開啟|已關閉/);
  });

  it.each([[false, "已關閉"], [true, "已開啟"]] as const)("GET %s → aria-checked 與 %s", async (on, label) => {
    render(<AutoListSwitch role="platform_admin" source={source([ok(on)])} />);
    expect((await screen.findByRole("switch")).getAttribute("aria-checked")).toBe(String(on));
    expect(screen.getByTestId("auto-list-state").textContent).toBe(label);
  });

  it("GET 失敗 → 顯示錯誤字串、不顯示開或關", async () => {
    render(
      <AutoListSwitch
        role="platform_admin"
        source={source([err(401, "unauthorized", "backend-401-<b>x</b>")])}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("backend-401-<b>x</b>");
    expect(alert.querySelector("b")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByTestId("auto-list").textContent).not.toMatch(/已開啟|已關閉/);
  });
});

describe("AutoListSwitch：開啟需確認", () => {
  it("關→開跳 alertdialog，說明只影響之後、關閉不撤銷而自然到期；焦點在取消，Esc 關閉不送出", async () => {
    const user = userEvent.setup();
    const s = source([ok(false)]);
    render(<AutoListSwitch role="platform_admin" source={s} />);
    const sw = await screen.findByRole("switch");
    await user.click(sw);
    const dlg = screen.getByRole("alertdialog");
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(dlg.textContent).toMatch(/只影響之後/);
    expect(dlg.textContent).toMatch(/不會撤銷/);
    expect(dlg.textContent).toMatch(/到期/);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "確認開啟" }));
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(sw);
    expect(s.putAutoList).not.toHaveBeenCalled();
  });

  it("確認後 409：顯示後端字串、重新 GET，開關維持關閉", async () => {
    const user = userEvent.setup();
    const s = source([ok(false), ok(false)], [err(409, "conflict", BACKEND_409)]);
    render(<AutoListSwitch role="platform_admin" source={s} />);
    await user.click(await screen.findByRole("switch"));
    await user.click(screen.getByRole("button", { name: "確認開啟" }));
    expect(s.putAutoList).toHaveBeenCalledWith({ enabled: true });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(BACKEND_409);
    expect(alert.querySelector("b")).toBeNull();
    await waitFor(() => expect(s.getAutoList).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("開啟成功：顯示值取重新 GET 的結果", async () => {
    const user = userEvent.setup();
    const s = source([ok(false), ok(true)], [ok(true)]);
    render(<AutoListSwitch role="platform_admin" source={s} />);
    await user.click(await screen.findByRole("switch"));
    await user.click(screen.getByRole("button", { name: "確認開啟" }));
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"),
    );
    expect(s.getAutoList).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("AutoListSwitch：關閉不需確認", () => {
  it("開→關直接 PUT false，不跳對話框", async () => {
    const user = userEvent.setup();
    const s = source([ok(true), ok(false)], [ok(false)]);
    render(<AutoListSwitch role="platform_admin" source={s} />);
    await user.click(await screen.findByRole("switch"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(s.putAutoList).toHaveBeenCalledWith({ enabled: false });
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"),
    );
    expect(s.getAutoList).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(screen.getByRole("switch"));
  });

  it("PUT 403 後重新 GET 也失敗 → 只顯示錯誤，不顯示開或關", async () => {
    const user = userEvent.setup();
    const s = source(
      [ok(true), err(500, "backend_unreachable", "後端無法連線，請稍後再試")],
      [err(403, "forbidden", BACKEND_403)],
    );
    render(<AutoListSwitch role="platform_admin" source={s} />);
    await user.click(await screen.findByRole("switch"));
    await waitFor(() => expect(screen.queryByRole("switch")).toBeNull());
    const text = screen.getByTestId("auto-list").textContent ?? "";
    expect(text).toContain(BACKEND_403);
    expect(text).not.toMatch(/已開啟|已關閉/);
  });

  it("寫入中連點（雙擊＋再點）：aria-disabled、只送 1 次 PUT，焦點留在開關", async () => {
    const user = userEvent.setup();
    let release: (r: R) => void = () => {};
    const s = {
      getAutoList: vi.fn(async () => ok(true)),
      putAutoList: vi.fn(() => new Promise<R>((res) => (release = res))),
    };
    render(<AutoListSwitch role="platform_admin" source={s} />);
    const sw = await screen.findByRole("switch");
    await user.dblClick(sw);
    expect(sw.getAttribute("aria-disabled")).toBe("true");
    expect(sw.hasAttribute("disabled")).toBe(false);
    expect(s.putAutoList).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(sw);
    await user.click(sw);
    await user.click(screen.getByText("自動上榜開關"));
    expect(s.putAutoList).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(sw);
    release(ok(false));
    await waitFor(() => expect(sw.getAttribute("aria-disabled")).toBe("false"));
    expect(document.activeElement).toBe(sw);
  });

  it.each([false, true])("點「自動上榜開關」文字等同點開關（GET %s）：關→確認框，開→直接 PUT false", async (on) => {
    const user = userEvent.setup();
    const s = source([ok(on), ok(false)]);
    render(<AutoListSwitch role="platform_admin" source={s} />);
    await screen.findByRole("switch");
    await user.click(screen.getByText("自動上榜開關"));
    expect(screen.queryByRole("alertdialog") !== null).toBe(!on);
    if (on) expect(s.putAutoList).toHaveBeenCalledWith({ enabled: false });
    else expect(s.putAutoList).not.toHaveBeenCalled();
  });

  it("文案不稱前端角色檢查為權限控管", async () => {
    const user = userEvent.setup();
    render(<AutoListSwitch role="platform_admin" source={source([ok(false)])} />);
    await user.click(await screen.findByRole("switch"));
    expect(document.body.textContent).not.toMatch(/權限控管/);
  });
});
