import { useCallback } from "react";
import { apiFetch, getTokenHelpText, MANAGEMENT_TOKEN_ERROR_MESSAGE } from "../utils/apiFetch";

export interface ApiError extends Error {
  isUnauthorized?: boolean;
}

export function useApi() {
  const request = useCallback(async (url: string, init?: RequestInit): Promise<Response> => {
    const res = await apiFetch(url, init);
    if (res.status === 401) {
      const err: ApiError = new Error(MANAGEMENT_TOKEN_ERROR_MESSAGE);
      err.isUnauthorized = true;
      throw err;
    }
    return res;
  }, []);

  const authMessage = useCallback(
    (context: string): string =>
      `${MANAGEMENT_TOKEN_ERROR_MESSAGE} Failed while ${context}. ${getTokenHelpText()}`,
    []
  );

  return { request, authMessage };
}
