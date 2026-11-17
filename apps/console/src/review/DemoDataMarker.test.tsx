import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("./reviewSource", () => ({
  reviewSource: { isDemo: vi.fn(() => false) },
}));

import { reviewSource } from "./reviewSource";
import { DemoDataMarker } from "./DemoDataMarker";

const isDemo = vi.mocked(reviewSource.isDemo);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DemoDataMarker", () => {
  it("示範模式顯示「示範資料」", () => {
    isDemo.mockReturnValue(true);
    render(<DemoDataMarker />);
    const mark = screen.getByTestId("demo-data-marker");
    expect(mark.textContent).toBe("示範資料");
    expect(mark.getAttribute("role")).toBe("status");
  });

  it("真實 API 模式不顯示標記", () => {
    isDemo.mockReturnValue(false);
    render(<DemoDataMarker />);
    expect(screen.queryByTestId("demo-data-marker")).toBeNull();
    expect(screen.queryByText("示範資料")).toBeNull();
  });
});
