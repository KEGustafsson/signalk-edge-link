/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor, act } from "@testing-library/react";
import { useConnections } from "../../../src/webapp/hooks/useConnections";

jest.mock("../../../src/webapp/utils/apiFetch", () => ({
  apiFetch: jest.fn(),
  getTokenHelpText: () => "",
  MANAGEMENT_TOKEN_ERROR_MESSAGE: "Management token required/invalid."
}));

const { apiFetch } = require("../../../src/webapp/utils/apiFetch");

const mockConnections = [
  { id: "c1", name: "Link 1", type: "client" },
  { id: "c2", name: "Link 2", type: "server" }
];

describe("useConnections", () => {
  beforeEach(() => jest.clearAllMocks());

  test("populates connections from /connections endpoint", async () => {
    (apiFetch as jest.Mock).mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(mockConnections)
    });

    const { result } = renderHook(() => useConnections());
    await waitFor(() => expect(result.current.connections).toHaveLength(2));
    expect(result.current.connections[0].id).toBe("c1");
  });

  test("falls back to legacy connection on network error", async () => {
    (apiFetch as jest.Mock).mockRejectedValue(new Error("network"));

    const { result } = renderHook(() => useConnections());
    await waitFor(() => expect(result.current.connections).toHaveLength(1));
    expect(result.current.connections[0].id).toBe("_legacy");
  });

  test("refetch updates connections", async () => {
    (apiFetch as jest.Mock)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: () => Promise.resolve([{ id: "c1", name: "Link 1", type: "client" }])
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: () => Promise.resolve(mockConnections)
      });

    const { result } = renderHook(() => useConnections());
    await waitFor(() => expect(result.current.connections).toHaveLength(1));

    // Wrap the refetch: it produces hook state updates that must be flushed
    // inside act() to avoid "not wrapped in act(...)" warnings.
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.connections).toHaveLength(2));
  });
});
