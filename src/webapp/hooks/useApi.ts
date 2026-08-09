import { useCallback } from "react";
import { apiFetch, getTokenHelpText, MANAGEMENT_TOKEN_ERROR_MESSAGE } from "../utils/apiFetch";

export interface ApiError extends Error {
  isUnauthorized?: boolean;
}

/**
 * Pull the server's `error` field out of a failed response.
 *
 * Falls back to the supplied default when the body is missing, not JSON, or
 * carries no message — a diagnostic must never be replaced by a parse failure.
 */
export async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.clone().json();
    const message = body && typeof body.error === "string" ? body.error.trim() : "";
    if (message) return message;
  } catch {
    // Not JSON, or already consumed — fall through.
  }
  return fallback;
}

export function useApi() {
  const request = useCallback(async (url: string, init?: RequestInit): Promise<Response> => {
    const res = await apiFetch(url, init);
    if (res.status === 401) {
      const err: ApiError = new Error(MANAGEMENT_TOKEN_ERROR_MESSAGE);
      err.isUnauthorized = true;
      throw err;
    }
    // 403 is the fail-closed lockout: `requireManagementApiToken` is on but no
    // token is configured. The server's body explains exactly how to recover,
    // so surface that instead of letting callers report a bare "Forbidden" —
    // the one message that leaves an operator with nowhere to go.
    if (res.status === 403) {
      const err: ApiError = new Error(await readErrorMessage(res, MANAGEMENT_TOKEN_ERROR_MESSAGE));
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
