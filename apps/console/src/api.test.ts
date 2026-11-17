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
    await expect(apiGet("/api/x")).resolves.toEqual({ status: 404, data: null, error: "x" });
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


describe("loginRequestSync 錯誤文案", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubStatus(status: number, body: unknown) {
    class FakeXHR {
      status = 0;
      responseText = "";
      withCredentials = false;
      open() {}
      setRequestHeader() {}
      send() {
        this.status = status;
        this.responseText = JSON.stringify(body);
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
  }

  it("401 使用既有帳密錯誤訊息", () => {
    stubStatus(401, { error: "帳號或密碼錯誤" });
    expect(loginRequestSync("x", "y")).toEqual({
      ok: false,
      status: 401,
      message: "帳號或密碼錯誤",
    });
  });

  it("400／401／403／404／409／429 的後端字串訊息截斷至約 200 字", () => {
    const long = "錯".repeat(250);
    for (const status of [400, 401, 403, 404, 409, 429]) {
      stubStatus(status, { error: long });
      const r = loginRequestSync("x", "y");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(status);
        expect(r.message).toBe("錯".repeat(200));
        expect(r.message.length).toBe(200);
      }
    }
  });

  it("5xx 與連線失敗顯示固定前端文案，不採用後端本文", () => {
    stubStatus(500, { error: "internal secret stack" });
    const five = loginRequestSync("x", "y");
    expect(five).toEqual({
      ok: false,
      status: 500,
      message: "後端無法連線，請稍後再試",
    });
    expect(five.ok === false && five.message).not.toMatch(/secret|internal/);

    class BoomXHR {
      status = 0;
      responseText = "";
      withCredentials = false;
      open() {}
      setRequestHeader() {}
      send() {
        throw new TypeError("Failed to fetch");
      }
    }
    vi.stubGlobal("XMLHttpRequest", BoomXHR as unknown as typeof XMLHttpRequest);
    expect(loginRequestSync("x", "y")).toEqual({
      ok: false,
      status: 0,
      message: "後端無法連線，請稍後再試",
    });
  });
});


describe("loginRequestSync 非字串錯誤", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubStatus(status: number, body: unknown) {
    class FakeXHR {
      status = 0;
      responseText = "";
      withCredentials = false;
      open() {}
      setRequestHeader() {}
      send() {
        this.status = status;
        this.responseText = JSON.stringify(body);
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
  }

  it("非字串 error／message 改用固定後備文案", () => {
    stubStatus(401, { error: { code: "auth" } });
    expect(loginRequestSync("x", "y")).toEqual({
      ok: false,
      status: 401,
      message: "帳號或密碼錯誤",
    });
    stubStatus(401, { message: 1 });
    expect(loginRequestSync("x", "y")).toEqual({
      ok: false,
      status: 401,
      message: "帳號或密碼錯誤",
    });
    stubStatus(429, { error: { retry: true } });
    expect(loginRequestSync("x", "y")).toEqual({
      ok: false,
      status: 429,
      message: "帳號或密碼錯誤，請稍後再試",
    });
  });
});

describe("apiGet 429／404", () => {
  beforeEach(() => {
    setUnauthorizedHandler(null);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    setUnauthorizedHandler(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("429 帶回後端原文（含稍後再試），不改寫", async () => {
    const verbatim = "帳號或密碼錯誤，請稍後再試";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: verbatim }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const r = await apiGet("/api/session/me");
    expect(r).toEqual({ status: 429, data: null, error: verbatim });
    expect(r.error).toContain("稍後再試");

    const long = "錯".repeat(250);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: long }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const truncated = await apiGet("/api/session/me");
    expect(truncated).toEqual({ status: 429, data: null, error: "錯".repeat(200) });
    expect(truncated.error?.length).toBe(200);
  });

  it("404 帶回後端 error 原文", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "查無應用" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(apiGet("/api/apps/x/map")).resolves.toEqual({
      status: 404,
      data: null,
      error: "查無應用",
    });
  });

  it("404／400／403／409 的後端字串訊息截斷至約 200 字", async () => {
    const long = "錯".repeat(250);
    for (const status of [404, 400, 403, 409]) {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(status, { error: long }));
      const r = await apiGet("/api/x");
      expect(r).toEqual({ status, data: null, error: "錯".repeat(200) });
      expect(r.error?.length).toBe(200);
    }
  });

  it("非字串 error／message 不採用；429 改用固定後備文案", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(404, { error: { code: "missing" } }));
    await expect(apiGet("/api/x")).resolves.toEqual({ status: 404, data: null });

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(400, { message: 1 }));
    await expect(apiGet("/api/x")).resolves.toEqual({ status: 400, data: null });

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(429, { error: { retry: true } }));
    await expect(apiGet("/api/x")).resolves.toEqual({
      status: 429,
      data: null,
      error: "帳號或密碼錯誤，請稍後再試",
    });
  });
});

/** 同步 XHR stub：send 拋錯（離線）。 */
function stubBoomXhr(): void {
  class BoomXHR {
    status = 0;
    responseText = "";
    withCredentials = false;
    open() {}
    setRequestHeader() {}
    send() {
      throw new Error("offline");
    }
  }
  vi.stubGlobal("XMLHttpRequest", BoomXHR as unknown as typeof XMLHttpRequest);
}

/** 同步 XHR stub：login 回 401 + message。 */
function stubFailLoginXhr(): void {
  class FailLoginXHR {
    status = 0;
    responseText = "";
    withCredentials = false;
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 401;
      this.responseText = JSON.stringify({ message: "帳號或密碼錯誤" });
    }
  }
  vi.stubGlobal("XMLHttpRequest", FailLoginXHR as unknown as typeof XMLHttpRequest);
}

/** 同步 XHR stub：login 2xx、/me 401。 */
function stubMeFailXhr(): void {
  const calls: string[] = [];
  class MeFailXHR {
    status = 0;
    responseText = "";
    withCredentials = false;
    open(_m: string, url: string) {
      calls.push(url);
    }
    setRequestHeader() {}
    send() {
      const url = calls[calls.length - 1]!;
      if (url.includes("login")) {
        this.status = 200;
        this.responseText = JSON.stringify({ ok: true });
        return;
      }
      this.status = 401;
      this.responseText = "{}";
    }
  }
  vi.stubGlobal("XMLHttpRequest", MeFailXHR as unknown as typeof XMLHttpRequest);
}

function stubFetch(): void {
  setUnauthorizedHandler(null);
  vi.stubGlobal("fetch", vi.fn());
}

function unstubAll(): void {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

describe("apiGet 其餘狀態分支", () => {
  beforeEach(stubFetch);
  afterEach(unstubAll);

  it("apiGet 500／壞 JSON／429 fallback／message 欄", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(500, { message: "伺服器忙碌" }),
    );
    await expect(apiGet("/api/x")).resolves.toEqual({
      status: 500,
      data: null,
      error: "伺服器忙碌",
    });

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("not-json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    await expect(apiGet("/api/x")).resolves.toEqual({ status: 200, data: null });

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("{}", { status: 429, headers: { "Content-Type": "application/json" } }),
    );
    await expect(apiGet("/api/x")).resolves.toEqual({
      status: 429,
      data: null,
      error: "帳號或密碼錯誤，請稍後再試",
    });
  });
});

describe("fetchMe 其餘狀態分支", () => {
  beforeEach(stubFetch);
  afterEach(unstubAll);

  it("fetchMe 401 非 quiet 觸發 handler；非 2xx 回 null", async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(401, {}));
    await expect(fetchMe()).resolves.toBeNull();
    expect(onUnauth).toHaveBeenCalledOnce();

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(503, {}));
    await expect(fetchMe()).resolves.toBeNull();
  });
});

describe("loginRequestSync 失敗分支", () => {
  afterEach(unstubAll);

  it("網路錯誤／4xx／me 失敗", () => {
    stubBoomXhr();
    expect(loginRequestSync("a", "b")).toEqual({
      ok: false,
      status: 0,
      message: "後端無法連線，請稍後再試",
    });

    stubFailLoginXhr();
    expect(loginRequestSync("a", "b")).toEqual({
      ok: false,
      status: 401,
      message: "帳號或密碼錯誤",
    });

    stubMeFailXhr();
    expect(loginRequestSync("a", "b")).toEqual({
      ok: false,
      status: 401,
      message: "帳號或密碼錯誤",
    });
  });
});
