/**
 * @jest-environment jsdom
 */

/* eslint-disable no-undef */

import {
  MANAGEMENT_TOKEN_ERROR_MESSAGE,
  getAuthToken,
  getTokenHelpText,
  apiFetch
} from "../src/webapp/utils/apiFetch";

describe("apiFetch module", () => {
  let originalLocation;

  beforeEach(() => {
    delete window.__EDGE_LINK_AUTH__;
    window.localStorage.clear();
    global.fetch = jest.fn(() => Promise.resolve({ ok: true }));

    // Save and mock location for query param tests
    originalLocation = window.location;
    delete window.location;
    window.location = { search: "", ...originalLocation };
  });

  afterEach(() => {
    window.location = originalLocation;
    jest.restoreAllMocks();
  });

  describe("MANAGEMENT_TOKEN_ERROR_MESSAGE", () => {
    it("is a non-empty string", () => {
      expect(typeof MANAGEMENT_TOKEN_ERROR_MESSAGE).toBe("string");
      expect(MANAGEMENT_TOKEN_ERROR_MESSAGE.length).toBeGreaterThan(0);
    });
  });

  describe("getAuthToken", () => {
    it("returns empty string when no token sources are available", () => {
      expect(getAuthToken()).toBe("");
    });

    it("returns token from window.__EDGE_LINK_AUTH__.token", () => {
      window.__EDGE_LINK_AUTH__ = { token: "direct-token" };
      expect(getAuthToken()).toBe("direct-token");
    });

    it("trims whitespace from direct token", () => {
      window.__EDGE_LINK_AUTH__ = { token: "  spaced-token  " };
      expect(getAuthToken()).toBe("spaced-token");
    });

    it("returns token from query parameter when includeTokenInQuery is enabled", () => {
      // Query-param token is opt-in (default is false to avoid leaking into browser history).
      window.__EDGE_LINK_AUTH__ = { includeTokenInQuery: true };
      window.location.search = "?edgeLinkToken=query-token";
      expect(getAuthToken()).toBe("query-token");
    });

    it("does NOT return token from query parameter by default (secure default)", () => {
      window.location.search = "?edgeLinkToken=query-token";
      expect(getAuthToken()).toBe("");
    });

    it("returns token from localStorage", () => {
      window.localStorage.setItem("signalkEdgeLinkManagementToken", "stored-token");
      expect(getAuthToken()).toBe("stored-token");
    });

    it("trims whitespace from localStorage token", () => {
      window.localStorage.setItem("signalkEdgeLinkManagementToken", "  stored  ");
      expect(getAuthToken()).toBe("stored");
    });

    it("prioritises direct token over query param and localStorage", () => {
      window.__EDGE_LINK_AUTH__ = { token: "direct" };
      window.location.search = "?edgeLinkToken=query";
      window.localStorage.setItem("signalkEdgeLinkManagementToken", "stored");
      expect(getAuthToken()).toBe("direct");
    });

    it("prioritises query param over localStorage when includeTokenInQuery is enabled", () => {
      window.__EDGE_LINK_AUTH__ = { includeTokenInQuery: true };
      window.location.search = "?edgeLinkToken=query";
      window.localStorage.setItem("signalkEdgeLinkManagementToken", "stored");
      expect(getAuthToken()).toBe("query");
    });

    it("falls back to localStorage when includeTokenInQuery is false (default)", () => {
      window.location.search = "?edgeLinkToken=query";
      window.localStorage.setItem("signalkEdgeLinkManagementToken", "stored");
      expect(getAuthToken()).toBe("stored");
    });

    it("uses custom localStorageKey from runtime config", () => {
      window.__EDGE_LINK_AUTH__ = { localStorageKey: "customKey" };
      window.localStorage.setItem("customKey", "custom-stored");
      expect(getAuthToken()).toBe("custom-stored");
    });

    it("uses custom queryParam from runtime config when includeTokenInQuery is enabled", () => {
      window.__EDGE_LINK_AUTH__ = { queryParam: "myToken", includeTokenInQuery: true };
      window.location.search = "?myToken=custom-query";
      expect(getAuthToken()).toBe("custom-query");
    });

    it("skips query param when includeTokenInQuery is false (explicit)", () => {
      window.__EDGE_LINK_AUTH__ = { includeTokenInQuery: false };
      window.location.search = "?edgeLinkToken=should-skip";
      window.localStorage.setItem("signalkEdgeLinkManagementToken", "fallback");
      expect(getAuthToken()).toBe("fallback");
    });

    it("skips query param by default (includeTokenInQuery defaults to false)", () => {
      // No __EDGE_LINK_AUTH__ override — default should NOT read query param.
      window.location.search = "?edgeLinkToken=should-skip";
      expect(getAuthToken()).toBe("");
    });

    it("ignores non-object __EDGE_LINK_AUTH__ values", () => {
      window.__EDGE_LINK_AUTH__ = "not-an-object";
      window.localStorage.setItem("signalkEdgeLinkManagementToken", "stored");
      expect(getAuthToken()).toBe("stored");
    });
  });

  describe("apiFetch – header modes", () => {
    it("sets both headers by default (headerMode 'both')", async () => {
      window.__EDGE_LINK_AUTH__ = { token: "tok123" };
      await apiFetch("/api/test");

      const [, opts] = global.fetch.mock.calls[0];
      const headers = opts.headers;
      expect(headers.get("X-Edge-Link-Token")).toBe("tok123");
      expect(headers.get("Authorization")).toBe("Bearer tok123");
    });

    it("sets only X-Edge-Link-Token when headerMode is 'x-edge-link-token'", async () => {
      window.__EDGE_LINK_AUTH__ = { token: "tok", headerMode: "x-edge-link-token" };
      await apiFetch("/api/test");

      const headers = global.fetch.mock.calls[0][1].headers;
      expect(headers.get("X-Edge-Link-Token")).toBe("tok");
      expect(headers.get("Authorization")).toBeNull();
    });

    it("sets only X-Edge-Link-Token when headerMode is 'token'", async () => {
      window.__EDGE_LINK_AUTH__ = { token: "tok", headerMode: "token" };
      await apiFetch("/api/test");

      const headers = global.fetch.mock.calls[0][1].headers;
      expect(headers.get("X-Edge-Link-Token")).toBe("tok");
      expect(headers.get("Authorization")).toBeNull();
    });

    it("sets only Authorization when headerMode is 'authorization'", async () => {
      window.__EDGE_LINK_AUTH__ = { token: "tok", headerMode: "authorization" };
      await apiFetch("/api/test");

      const headers = global.fetch.mock.calls[0][1].headers;
      expect(headers.get("X-Edge-Link-Token")).toBeNull();
      expect(headers.get("Authorization")).toBe("Bearer tok");
    });

    it("sets only Authorization when headerMode is 'bearer'", async () => {
      window.__EDGE_LINK_AUTH__ = { token: "tok", headerMode: "bearer" };
      await apiFetch("/api/test");

      const headers = global.fetch.mock.calls[0][1].headers;
      expect(headers.get("X-Edge-Link-Token")).toBeNull();
      expect(headers.get("Authorization")).toBe("Bearer tok");
    });

    it("adds no auth headers when token is empty", async () => {
      await apiFetch("/api/test");

      const headers = global.fetch.mock.calls[0][1].headers;
      expect(headers.get("X-Edge-Link-Token")).toBeNull();
      expect(headers.get("Authorization")).toBeNull();
    });
  });

  describe("apiFetch – request forwarding", () => {
    it("passes through the url and init options to fetch", async () => {
      window.__EDGE_LINK_AUTH__ = { token: "t" };
      await apiFetch("/api/data", { method: "POST", body: '{"a":1}' });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toBe("/api/data");
      expect(opts.method).toBe("POST");
      expect(opts.body).toBe('{"a":1}');
    });

    it("preserves existing headers from init", async () => {
      window.__EDGE_LINK_AUTH__ = { token: "t" };
      await apiFetch("/api/data", {
        headers: { "Content-Type": "application/json" }
      });

      const headers = global.fetch.mock.calls[0][1].headers;
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("X-Edge-Link-Token")).toBe("t");
    });
  });

  describe("getTokenHelpText", () => {
    it("mentions both header types with default config", () => {
      const text = getTokenHelpText();
      expect(text).toContain("X-Edge-Link-Token");
      expect(text).toContain("Authorization: Bearer");
      expect(text).toContain("managementApiToken");
      expect(text).toContain("SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN");
      expect(text).toContain("edgeLinkToken");
      expect(text).toContain("signalkEdgeLinkManagementToken");
    });

    it("mentions only Authorization for authorization mode", () => {
      window.__EDGE_LINK_AUTH__ = { headerMode: "authorization" };
      const text = getTokenHelpText();
      expect(text).toContain("Authorization: Bearer");
      expect(text).not.toContain("X-Edge-Link-Token and");
    });

    it("mentions only X-Edge-Link-Token for token mode", () => {
      window.__EDGE_LINK_AUTH__ = { headerMode: "x-edge-link-token" };
      const text = getTokenHelpText();
      expect(text).toContain("X-Edge-Link-Token");
      expect(text).not.toContain("Authorization");
    });

    it("uses custom queryParam and localStorageKey in text", () => {
      window.__EDGE_LINK_AUTH__ = { queryParam: "myQ", localStorageKey: "myLS" };
      const text = getTokenHelpText();
      expect(text).toContain("myQ");
      expect(text).toContain("myLS");
    });
  });
});
