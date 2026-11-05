import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import * as api from "./api";
import type { SessionUser } from "./roles";

function Probe() {
  const { user, ready, login, logout } = useAuth();
  return (
    <div>
      <span data-testid="ready">{ready ? "yes" : "no"}</span>
      <span data-testid="user">{user ? `${user.username}:${user.role}` : "none"}</span>
      <button
        type="button"
        data-testid="do-login"
        onClick={() => {
          login("operator1", "pass-operator-1");
        }}
      >
        login
      </button>
      <button
        type="button"
        data-testid="do-logout"
        onClick={() => {
          void logout();
        }}
      >
        logout
      </button>
    </div>
  );
}

describe("auth", () => {
  beforeEach(() => {
    vi.spyOn(api, "fetchMe").mockResolvedValue(null);
    vi.spyOn(api, "setUnauthorizedHandler").mockImplementation(() => {});
    vi.spyOn(api, "loginRequestSync").mockReturnValue({
      ok: true,
      user: { username: "operator1", role: "operator" },
    });
    vi.spyOn(api, "logoutRequest").mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("useAuth 在 Provider 外拋錯", () => {
    expect(() => render(<Probe />)).toThrow(/AuthProvider/);
  });

  it("ready 在首次 /me 完成前為 false，完成後為 true", async () => {
    let resolveMe!: (v: SessionUser | null) => void;
    vi.mocked(api.fetchMe).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMe = resolve;
        }),
    );
    render(
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("ready").textContent).toBe("no");
    resolveMe(null);
    await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("yes"));
    expect(screen.getByTestId("user").textContent).toBe("none");
  });

  it("login 成功後寫入 user；logout 清空", async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("ready").textContent).toBe("yes"));
    screen.getByTestId("do-login").click();
    await waitFor(() =>
      expect(screen.getByTestId("user").textContent).toBe("operator1:operator"),
    );
    screen.getByTestId("do-logout").click();
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("none"));
  });
});
