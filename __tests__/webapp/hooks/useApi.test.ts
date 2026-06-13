/**
 * @jest-environment jsdom
 */
import { renderHook, act } from "@testing-library/react";
import { useApi } from "../../../src/webapp/hooks/useApi";

// Mock apiFetch
jest.mock("../../../src/webapp/utils/apiFetch", () => ({
  apiFetch: jest.fn(),
  getTokenHelpText: () => "token help",
  MANAGEMENT_TOKEN_ERROR_MESSAGE: "Management token required/invalid."
}));

const { apiFetch } = require("../../../src/webapp/utils/apiFetch");

describe("useApi", () => {
  beforeEach(() => jest.clearAllMocks());

  test("request resolves for OK responses", async () => {
    const fakeRes = { status: 200, ok: true };
    (apiFetch as jest.Mock).mockResolvedValue(fakeRes);

    const { result } = renderHook(() => useApi());
    const res = await act(() => result.current.request("/test"));
    expect(res).toBe(fakeRes);
  });

  test("request throws ApiError with isUnauthorized for 401", async () => {
    (apiFetch as jest.Mock).mockResolvedValue({ status: 401 });

    const { result } = renderHook(() => useApi());
    await expect(act(() => result.current.request("/test"))).rejects.toMatchObject({
      isUnauthorized: true,
      message: "Management token required/invalid."
    });
  });

  test("authMessage includes context and token help", () => {
    const { result } = renderHook(() => useApi());
    const msg = result.current.authMessage("saving config");
    expect(msg).toContain("saving config");
    expect(msg).toContain("Management token required/invalid.");
  });
});
