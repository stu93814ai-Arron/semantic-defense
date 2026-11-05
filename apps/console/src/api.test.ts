import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiGet,
  fetchMe,
  loginRequestSync,
  logoutRequest,
  setUnauthorizedHandler,
} from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("apiGet / fetchMe / logout", () => {
  beforeEach(() => {
    setUnauthorizedHandler(null);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    setUnauthorizedHandler(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("apiGet 回傳 JSON；非 2xx 為 null data", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { items: [] }));
    await expect(apiGet("/api/judgments")).resolves.toEqual({
      status: 200,
      data: { items: [] },
    });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(404, { error: "x" }));
    await expect(apiGet("/api/x")).resolves.toEqual({ status: 404, data: null });
  });

  it("apiGet 401 觸發 unauthorized handler", async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(401, { error: "未登入" }));
    await expect(apiGet("/api/judgments")).resolves.toEqual({ status: 401, data: null });
    expect(onUnauth).toHaveBeenCalledOnce();
  });

  it("fetchMe 解析 username/role；缺欄位回 null", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, { username: "operator1", role: "operator" }),
    );
    await expect(fetchMe()).resolves.toEqual({
      username: "operator1",
      role: "operator",
    });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { username: "x" }));
    await expect(fetchMe()).resolves.toBeNull();
  });

  it("fetchMe 401 quiet 不呼叫 handler", async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(401, { error: "未登入" }));
    await expect(fetchMe({ quiet: true })).resolves.toBeNull();
    expect(onUnauth).not.toHaveBeenCalled();
  });

  it("logoutRequest 以 POST credentials 打 logout", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await logoutRequest();
    expect(fetch).toHaveBeenCalledWith("/api/session/logout", {
      method: "POST",
      credentials: "include",
    });
  });
});

describe("loginRequestSync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("2xx 後打 /me；429 原文錯誤", () => {
    const calls: Array<{ method: string; url: string }> = [];

    class RateXHR {
      status = 0;
      responseText = "";
      withCredentials = false;
      open(method: string, url: string) {
        calls.push({ method, url });
      }
      setRequestHeader() {}
      send() {
        this.status = 429;
        this.responseText = JSON.stringify({
          error: "帳號或密碼錯誤，請稍後再試",
        });
      }
    }
    vi.stubGlobal("XMLHttpRequest", RateXHR as unknown as typeof XMLHttpRequest);
    expect(loginRequestSync("operator1", "bad")).toEqual({
      ok: false,
      status: 429,
      message: "帳號或密碼錯誤，請稍後再試",
    });

    class OkXHR {
      status = 0;
      responseText = "";
      withCredentials = false;
      open(method: string, url: string) {
        calls.push({ method, url });
      }
      setRequestHeader() {}
      send() {
        const last = calls[calls.length - 1]!;
        if (last.url === "/api/session/login") {
          this.status = 200;
          this.responseText = JSON.stringify({ ok: true });
          return;
        }
        this.status = 200;
        this.responseText = JSON.stringify({
          username: "operator1",
          role: "operator",
        });
      }
    }
    calls.length = 0;
    vi.stubGlobal("XMLHttpRequest", OkXHR as unknown as typeof XMLHttpRequest);
    expect(loginRequestSync("operator1", "pass-operator-1")).toEqual({
      ok: true,
      user: { username: "operator1", role: "operator" },
    });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/session/login",
      "/api/session/me",
    ]);
  });
});
