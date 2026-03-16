/// <reference lib="dom" />

export const MANAGEMENT_TOKEN_ERROR_MESSAGE = "Management token required/invalid.";

interface AuthConfig {
  token: string | null;
  localStorageKey: string;
  queryParam: string;
  includeTokenInQuery: boolean;
  headerMode: string;
}

declare global {
  interface Window {
    __EDGE_LINK_AUTH__?: Partial<AuthConfig>;
  }
}

const DEFAULT_AUTH_CONFIG: AuthConfig = {
  token: null,
  localStorageKey: "signalkEdgeLinkManagementToken",
  queryParam: "edgeLinkToken",
  // Default to false: query-parameter tokens leak into browser history, server
  // access logs, and Referer headers. Set includeTokenInQuery: true in
  // window.__EDGE_LINK_AUTH__ only when you explicitly need URL-based auth.
  includeTokenInQuery: false,
  headerMode: "both"
};

function readRuntimeAuthConfig(): AuthConfig {
  if (typeof window === "undefined") {
    return DEFAULT_AUTH_CONFIG;
  }

  const runtime = window.__EDGE_LINK_AUTH__;
  if (!runtime || typeof runtime !== "object") {
    return DEFAULT_AUTH_CONFIG;
  }

  return { ...DEFAULT_AUTH_CONFIG, ...runtime };
}

function resolveToken(config: AuthConfig): string {
  if (config.token) {
    return String(config.token).trim();
  }

  if (typeof window === "undefined") {
    return "";
  }

  // SECURITY NOTE: Query parameter tokens can leak into browser history, server
  // access logs, and Referer headers.  Prefer localStorage or
  // window.__EDGE_LINK_AUTH__.token for production deployments.  Set
  // includeTokenInQuery: false in __EDGE_LINK_AUTH__ to disable this path.
  if (config.includeTokenInQuery && config.queryParam) {
    const tokenFromQuery = new URLSearchParams(window.location.search).get(config.queryParam);
    if (tokenFromQuery) {
      return tokenFromQuery.trim();
    }
  }

  if (config.localStorageKey && window.localStorage) {
    const tokenFromStorage = window.localStorage.getItem(config.localStorageKey);
    if (tokenFromStorage) {
      return tokenFromStorage.trim();
    }
  }

  return "";
}

function attachAuthHeaders(headers: Headers, token: string, headerMode: string): Headers {
  if (!token) {
    return headers;
  }

  const normalizedMode = (headerMode || "both").toLowerCase();
  if (
    normalizedMode === "x-edge-link-token" ||
    normalizedMode === "token" ||
    normalizedMode === "both"
  ) {
    headers.set("X-Edge-Link-Token", token);
  }
  if (
    normalizedMode === "authorization" ||
    normalizedMode === "bearer" ||
    normalizedMode === "both"
  ) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

export function getAuthToken(): string {
  const config = readRuntimeAuthConfig();
  return resolveToken(config);
}

export function getTokenHelpText(): string {
  const config = readRuntimeAuthConfig();
  const modeText =
    config.headerMode && String(config.headerMode).toLowerCase() === "authorization"
      ? "Authorization: Bearer <token>"
      : config.headerMode && String(config.headerMode).toLowerCase() === "x-edge-link-token"
        ? "X-Edge-Link-Token"
        : "X-Edge-Link-Token and Authorization: Bearer <token>";

  return `The server-side token is configured in plugin settings (managementApiToken) or via the SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN environment variable. To authenticate from the browser, provide the token using window.__EDGE_LINK_AUTH__.token, query parameter "${config.queryParam}", or localStorage key "${config.localStorageKey}". Requests send ${modeText} when a token is available.`;
}

export function apiFetch(input: string | Request, init: RequestInit = {}): Promise<Response> {
  const config = readRuntimeAuthConfig();
  const token = resolveToken(config);
  const headers = new Headers(init.headers || {});
  attachAuthHeaders(headers, token, config.headerMode);

  return fetch(input, {
    ...init,
    headers
  });
}
