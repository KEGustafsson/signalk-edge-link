/**
 * @jest-environment jsdom
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import { useMetricsPolling } from "../../../src/webapp/hooks/useMetricsPolling";

jest.mock("../../../src/webapp/utils/apiFetch", () => ({
  apiFetch: jest.fn(),
  getTokenHelpText: () => "",
  MANAGEMENT_TOKEN_ERROR_MESSAGE: "Management token required/invalid."
}));

const { apiFetch } = require("../../../src/webapp/utils/apiFetch");

const fakeMetrics = {
  mode: "client",
  protocolVersion: 1,
  stats: {},
  status: {},
  uptime: { formatted: "1m" }
};

describe("useMetricsPolling", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());

  test("calls onData immediately on mount", async () => {
    (apiFetch as jest.Mock).mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => fakeMetrics
    });

    const onData = jest.fn();
    renderHook(() => useMetricsPolling("conn-1", onData));

    await waitFor(() => expect(onData).toHaveBeenCalledWith(fakeMetrics));
  });

  test("does not poll when connId is null", async () => {
    (apiFetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => fakeMetrics });
    const onData = jest.fn();

    renderHook(() => useMetricsPolling(null, onData));
    await act(async () => {
      jest.advanceTimersByTime(20000);
    });

    expect(apiFetch).not.toHaveBeenCalled();
    expect(onData).not.toHaveBeenCalled();
  });

  test("cleans up interval on unmount", () => {
    (apiFetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => fakeMetrics });
    const onData = jest.fn();
    const { unmount } = renderHook(() => useMetricsPolling("conn-1", onData));
    const clearSpy = jest.spyOn(global, "clearInterval");
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});
