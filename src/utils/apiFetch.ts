export const MANAGEMENT_TOKEN_ERROR_MESSAGE = "Management token required/invalid.";

const DEFAULT_AUTH_CONFIG = {
  token: null,
  localStorageKey: "signalkEdgeLinkManagementToken",
  queryParam: "edgeLinkToken",
  includeTokenInQuery: true,
  headerMode: "both"
};

function readRuntimeAuthConfig() {
  if (typeof window === "undefined") {
    return DEFAULT_AUTH_CONFIG;
  }

  const runtime = window.__EDGE_LINK_AUTH__;
  if (!runtime || typeof runtime !== "object") {
    return DEFAULT_AUTH_CONFIG;
  }

  return { ...DEFAULT_AUTH_CONFIG, ...runtime };
}

function resolveToken(config) {
  if (config.token) {
    return String(config.token).trim();
  }

  if (typeof window === "undefined") {
    return "";
  }

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

function attachAuthHeaders(headers, token, headerMode) {
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

export function getAuthToken() {
  const config = readRuntimeAuthConfig();
  return resolveToken(config);
}

export function getTokenHelpText() {
  const config = readRuntimeAuthConfig();
  const modeText =
    config.headerMode && String(config.headerMode).toLowerCase() === "authorization"
      ? "Authorization: Bearer <token>"
      : config.headerMode && String(config.headerMode).toLowerCase() === "x-edge-link-token"
        ? "X-Edge-Link-Token"
        : "X-Edge-Link-Token and Authorization: Bearer <token>";

  return `Set a management token using window.__EDGE_LINK_AUTH__.token, query parameter "${config.queryParam}", or localStorage key "${config.localStorageKey}". Requests send ${modeText} when a token is available.`;
}

export function apiFetch(input, init = {}) {
  const config = readRuntimeAuthConfig();
  const token = resolveToken(config);
  const headers = new Headers(init.headers || {});
  attachAuthHeaders(headers, token, config.headerMode);

  return fetch(input, {
    ...init,
    headers
  });
}
