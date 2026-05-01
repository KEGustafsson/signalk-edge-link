/**
 * @jest-environment jsdom
 */

/* eslint-disable no-undef */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock("../src/webapp/utils/apiFetch", () => ({
  apiFetch: jest.fn(),
  MANAGEMENT_TOKEN_ERROR_MESSAGE: "Management token required/invalid."
}));

// Lightweight RJSF mock – keeps tests fast and focused on panel logic,
// not on RJSF form rendering internals.
const mockRjsfForms = [];
jest.mock("@rjsf/core", () => {
  const ReactMock = require("react");
  function MockForm({ children, formData, schema, onChange }) {
    mockRjsfForms.push({ formData, schema, onChange });
    return ReactMock.createElement(
      "div",
      {
        "data-testid": "rjsf-form",
        "data-formdata": JSON.stringify(formData),
        "data-schema": JSON.stringify(schema)
      },
      children
    );
  }
  return { __esModule: true, default: MockForm };
});

jest.mock("@rjsf/validator-ajv8", () => ({
  __esModule: true,
  default: { validate: jest.fn(), isValid: jest.fn(() => true) }
}));

jest.mock("@rjsf/utils", () => ({
  // Passthrough: return the caller's formData unchanged so tests don't depend
  // on RJSF's default-expansion logic.
  getDefaultFormState: (_validator, _schema, formData) => formData
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import { apiFetch } from "../src/webapp/utils/apiFetch";
import PluginConfigurationPanel from "../src/webapp/components/PluginConfigurationPanel";

function makeOk(data) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(data)
  });
}

function makeErr(status, errorMsg) {
  return Promise.resolve({
    ok: false,
    status,
    statusText: errorMsg,
    json: () => Promise.resolve({ error: errorMsg })
  });
}

function latestRjsfForm() {
  return mockRjsfForms[mockRjsfForms.length - 1];
}

function currentRjsfFormData() {
  return JSON.parse(screen.getByTestId("rjsf-form").getAttribute("data-formdata") || "{}");
}

const ONE_SERVER = {
  success: true,
  configuration: {
    connections: [
      {
        name: "shore-server",
        serverType: "server",
        udpPort: 4446,
        secretKey: "a".repeat(32),
        protocolVersion: 1
      }
    ],
    managementApiToken: "",
    requireManagementApiToken: false
  }
};

const TWO_CONNECTIONS = {
  success: true,
  configuration: {
    connections: [
      { name: "srv1", serverType: "server", udpPort: 4446, secretKey: "a".repeat(32) },
      {
        name: "cli1",
        serverType: "client",
        udpPort: 4447,
        secretKey: "b".repeat(32),
        udpAddress: "1.2.3.4",
        testAddress: "8.8.8.8",
        testPort: 80
      }
    ]
  }
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PluginConfigurationPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRjsfForms.length = 0;
  });

  // ── Loading & error states ─────────────────────────────────────────────────

  test("shows loading state initially", () => {
    apiFetch.mockReturnValueOnce(new Promise(() => {})); // never resolves
    render(React.createElement(PluginConfigurationPanel));
    expect(screen.getByText("Loading configuration...")).toBeInTheDocument();
  });

  test("shows error when network call throws", async () => {
    apiFetch.mockRejectedValueOnce(new Error("Network failure"));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() =>
      expect(screen.getByText(/Error loading configuration/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/Network failure/i)).toBeInTheDocument();
  });

  test("shows error when server returns non-ok response", async () => {
    apiFetch.mockResolvedValueOnce(makeErr(500, "Internal Server Error"));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() =>
      expect(screen.getByText(/Error loading configuration/i)).toBeInTheDocument()
    );
  });

  test("shows auth error message on 401", async () => {
    apiFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: () => Promise.resolve({})
    });
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => expect(screen.getByText(/Management token required/i)).toBeInTheDocument());
  });

  // ── Successful load ────────────────────────────────────────────────────────

  test("renders connection name and mode badge after load", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => expect(screen.getByText("shore-server")).toBeInTheDocument());
    expect(screen.getByText("Server")).toBeInTheDocument();
  });

  test("creates a default client connection when config has no connections", async () => {
    apiFetch.mockResolvedValueOnce(makeOk({ success: true, configuration: {} }));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => expect(screen.getByText("Client")).toBeInTheDocument());
  });

  test("wraps legacy flat config as a single connection", async () => {
    apiFetch.mockResolvedValueOnce(
      makeOk({
        success: true,
        configuration: {
          serverType: "server",
          udpPort: 4446,
          secretKey: "a".repeat(32),
          name: "legacy"
        }
      })
    );
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => expect(screen.getByText("legacy")).toBeInTheDocument());
    expect(screen.getByText("Server")).toBeInTheDocument();
  });

  // ── Adding connections ────────────────────────────────────────────────────

  test("+ Add Server creates a server card", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));

    fireEvent.click(screen.getByText("+ Add Server"));
    expect(screen.getAllByText("Server").length).toBeGreaterThanOrEqual(2);
  });

  test("+ Add Client creates a client card", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));

    fireEvent.click(screen.getByText("+ Add Client"));
    expect(screen.getByText("Client")).toBeInTheDocument();
  });

  // ── Remove connection ─────────────────────────────────────────────────────

  test("Remove button is disabled when only one connection exists", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));
    expect(screen.getByText("Remove")).toBeDisabled();
  });

  test("Remove button is enabled when multiple connections exist", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(TWO_CONNECTIONS));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("srv1"));
    screen.getAllByText("Remove").forEach((btn) => expect(btn).toBeEnabled());
  });

  test("clicking Remove deletes that connection", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(TWO_CONNECTIONS));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("srv1"));

    fireEvent.click(screen.getAllByText("Remove")[0]);
    await waitFor(() => expect(screen.queryByText("srv1")).not.toBeInTheDocument());
    expect(screen.getByText("cli1")).toBeInTheDocument();
  });

  // ── Expand / collapse ─────────────────────────────────────────────────────

  test("first card is expanded by default (RJSF form visible)", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));
    expect(screen.getByTestId("rjsf-form")).toBeInTheDocument();
  });

  test("clicking card header collapses then re-expands it", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));

    // Collapse
    fireEvent.click(screen.getByText("shore-server"));
    await waitFor(() => expect(screen.queryByTestId("rjsf-form")).not.toBeInTheDocument());

    // Expand again
    fireEvent.click(screen.getByText("shore-server"));
    await waitFor(() => expect(screen.getByTestId("rjsf-form")).toBeInTheDocument());
  });

  // ── Dirty banner ──────────────────────────────────────────────────────────

  test("no dirty banner on clean load", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));
    expect(screen.queryByText("You have unsaved changes.")).not.toBeInTheDocument();
  });

  test("does not mark dirty when RJSF emits unchanged form data", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));

    await act(async () => {
      latestRjsfForm().onChange({ formData: currentRjsfFormData() });
    });

    expect(screen.queryByText("You have unsaved changes.")).not.toBeInTheDocument();
  });

  test("dirty banner appears after adding a connection", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));

    fireEvent.click(screen.getByText("+ Add Server"));
    expect(screen.getByText("You have unsaved changes.")).toBeInTheDocument();
  });

  test("dirty banner appears after removing a connection", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(TWO_CONNECTIONS));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("srv1"));

    fireEvent.click(screen.getAllByText("Remove")[0]);
    await waitFor(() => expect(screen.getByText("You have unsaved changes.")).toBeInTheDocument());
  });

  // ── Toolbar connection counter ────────────────────────────────────────────

  test("toolbar shows correct connection count", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));
    expect(screen.getByText(/1 connection\b/)).toBeInTheDocument();
    expect(screen.getByText(/1 server\b/)).toBeInTheDocument();
    expect(screen.getByText(/0 clients\b/)).toBeInTheDocument();
  });

  test("toolbar counter updates after adding connections", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));

    fireEvent.click(screen.getByText("+ Add Client"));
    expect(screen.getByText(/2 connections\b/)).toBeInTheDocument();
    expect(screen.getByText(/1 client\b/)).toBeInTheDocument();
  });

  // ── Duplicate port warning ────────────────────────────────────────────────

  test("shows duplicate port warning when two servers share the same UDP port", async () => {
    apiFetch.mockResolvedValueOnce(
      makeOk({
        success: true,
        configuration: {
          connections: [
            { name: "srv1", serverType: "server", udpPort: 4446, secretKey: "a".repeat(32) },
            { name: "srv2", serverType: "server", udpPort: 4446, secretKey: "b".repeat(32) }
          ]
        }
      })
    );
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("srv1"));
    expect(
      screen.getAllByText(/Port 4446 is used by multiple server connections/).length
    ).toBeGreaterThanOrEqual(1);
  });

  test("no duplicate port warning when servers use different ports", async () => {
    apiFetch.mockResolvedValueOnce(
      makeOk({
        success: true,
        configuration: {
          connections: [
            { name: "srv1", serverType: "server", udpPort: 4446, secretKey: "a".repeat(32) },
            { name: "srv2", serverType: "server", udpPort: 4447, secretKey: "b".repeat(32) }
          ]
        }
      })
    );
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("srv1"));
    expect(screen.queryByText(/is used by multiple server connections/)).not.toBeInTheDocument();
  });

  // ── Save ─────────────────────────────────────────────────────────────────

  test("Save Configuration POSTs connections without _id field", async () => {
    apiFetch
      .mockResolvedValueOnce(makeOk(ONE_SERVER))
      .mockResolvedValueOnce(makeOk({ success: true, message: "Saved." }));

    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));

    await act(async () => {
      fireEvent.click(screen.getByText("Save Configuration"));
    });

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    const [, postCall] = apiFetch.mock.calls;
    expect(postCall[1].method).toBe("POST");
    const body = JSON.parse(postCall[1].body);
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).not.toHaveProperty("_id");
    expect(body.connections[0].connectionId).toEqual(expect.any(String));
    expect(body.connections[0].name).toBe("shore-server");
  });

  test("preserves connection identity when switching mode through RJSF", async () => {
    apiFetch
      .mockResolvedValueOnce(makeOk(ONE_SERVER))
      .mockResolvedValueOnce(makeOk({ success: true, message: "Saved." }));

    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));
    const initialFormData = currentRjsfFormData();

    await act(async () => {
      latestRjsfForm().onChange({
        formData: {
          ...initialFormData,
          serverType: "client",
          stretchAsciiKey: true,
          useMsgpack: true,
          usePathDictionary: true,
          protocolVersion: 3
        }
      });
    });

    await waitFor(() => expect(screen.getByText("Client")).toBeInTheDocument());
    expect(screen.getByText("You have unsaved changes.")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText("Save Changes"));
    });

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    const body = JSON.parse(apiFetch.mock.calls[1][1].body);
    const saved = body.connections[0];
    expect(saved).not.toHaveProperty("_id");
    expect(saved.connectionId).toBe(initialFormData.connectionId);
    expect(saved.name).toBe("shore-server");
    expect(saved.serverType).toBe("client");
    expect(saved.udpPort).toBe(4446);
    expect(saved.secretKey).toBe("a".repeat(32));
    expect(saved.stretchAsciiKey).toBe(true);
    expect(saved.useMsgpack).toBe(true);
    expect(saved.usePathDictionary).toBe(true);
    expect(saved.protocolVersion).toBe(3);
  });

  test("Save includes managementApiToken in POST body", async () => {
    apiFetch
      .mockResolvedValueOnce(
        makeOk({
          success: true,
          configuration: {
            connections: ONE_SERVER.configuration.connections,
            managementApiToken: "secret-token",
            requireManagementApiToken: true
          }
        })
      )
      .mockResolvedValueOnce(makeOk({ success: true, message: "Saved." }));

    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));

    await act(async () => {
      fireEvent.click(screen.getByText("Save Configuration"));
    });

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    const body = JSON.parse(apiFetch.mock.calls[1][1].body);
    expect(body.managementApiToken).toBe("secret-token");
    expect(body.requireManagementApiToken).toBe(true);
  });

  test("shows success message after save", async () => {
    apiFetch
      .mockResolvedValueOnce(makeOk(ONE_SERVER))
      .mockResolvedValueOnce(
        makeOk({ success: true, message: "Configuration saved. Plugin restarting..." })
      );

    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));

    await act(async () => {
      fireEvent.click(screen.getByText("Save Configuration"));
    });

    await waitFor(() =>
      expect(screen.getByText("Configuration saved. Plugin restarting...")).toBeInTheDocument()
    );
  });

  test("shows error message when save fails", async () => {
    apiFetch
      .mockResolvedValueOnce(makeOk(ONE_SERVER))
      .mockResolvedValueOnce(makeErr(500, "Database write failed"));

    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));

    await act(async () => {
      fireEvent.click(screen.getByText("Save Configuration"));
    });

    await waitFor(() => expect(screen.getByText("Database write failed")).toBeInTheDocument());
  });

  test("shows 401 error message when save is unauthorised", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER)).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: () => Promise.resolve({})
    });

    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));

    await act(async () => {
      fireEvent.click(screen.getByText("Save Configuration"));
    });

    await waitFor(() => expect(screen.getByText(/Management token required/i)).toBeInTheDocument());
  });

  test("duplicate port error prevents save and shows inline message", async () => {
    apiFetch.mockResolvedValueOnce(
      makeOk({
        success: true,
        configuration: {
          connections: [
            { name: "srv1", serverType: "server", udpPort: 4446, secretKey: "a".repeat(32) },
            { name: "srv2", serverType: "server", udpPort: 4446, secretKey: "b".repeat(32) }
          ]
        }
      })
    );

    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("srv1"));

    fireEvent.click(screen.getByText("Save Configuration"));

    await waitFor(() =>
      expect(screen.getByText(/Duplicate server ports detected/i)).toBeInTheDocument()
    );
    // POST should not have been called
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  // ── Security settings ────────────────────────────────────────────────────

  test("management API token input is rendered", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));
    expect(screen.getByLabelText("Management API Token")).toBeInTheDocument();
  });

  test("typing in token field marks panel dirty", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));

    fireEvent.change(screen.getByLabelText("Management API Token"), {
      target: { value: "my-secret" }
    });
    expect(screen.getByText("You have unsaved changes.")).toBeInTheDocument();
  });

  test("require management token checkbox reflects loaded config", async () => {
    apiFetch.mockResolvedValueOnce(
      makeOk({
        success: true,
        configuration: {
          ...ONE_SERVER.configuration,
          requireManagementApiToken: true
        }
      })
    );
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  test("toggling require-token checkbox marks panel dirty", async () => {
    apiFetch.mockResolvedValueOnce(makeOk(ONE_SERVER));
    render(React.createElement(PluginConfigurationPanel));
    await waitFor(() => screen.getByText("shore-server"));

    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText("You have unsaved changes.")).toBeInTheDocument();
  });
});
