/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import { App } from "../../src/webapp/App";

jest.mock("../../src/webapp/utils/apiFetch", () => ({
  apiFetch: jest.fn(),
  getTokenHelpText: () => "token help text",
  MANAGEMENT_TOKEN_ERROR_MESSAGE: "Management token required/invalid."
}));

const { apiFetch } = require("../../src/webapp/utils/apiFetch");

function mockOkJson(data: unknown) {
  return { status: 200, ok: true, json: () => Promise.resolve(data) };
}

describe("App", () => {
  beforeEach(() => jest.clearAllMocks());

  test("renders header", async () => {
    (apiFetch as jest.Mock).mockResolvedValue({ status: 200, ok: false });
    // Wrap render in act and flush pending effects: App fires async fetches on
    // mount whose resolution updates state after the synchronous assertions,
    // which would otherwise log "not wrapped in act(...)".
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByText("SignalK Edge Link")).toBeInTheDocument();
    expect(screen.getByText("Configuration and runtime monitoring")).toBeInTheDocument();
  });

  test("renders client dashboard for client connection", async () => {
    (apiFetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes("/connections")) {
        return Promise.resolve(
          mockOkJson([{ id: "c1", name: "My Client", type: "client", readyToSend: true }])
        );
      }
      if (url.includes("/plugin-config")) {
        return Promise.resolve(mockOkJson({ configuration: {} }));
      }
      if (url.includes("/plugin-schema")) {
        return Promise.resolve(mockOkJson({ schema: {} }));
      }
      // config files + metrics
      return Promise.resolve({ status: 200, ok: false });
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("Configuration")).toBeInTheDocument());
  });

  test("renders tabs when multiple connections exist", async () => {
    (apiFetch as jest.Mock).mockImplementation((url: string) => {
      if (url.includes("/connections")) {
        return Promise.resolve(
          mockOkJson([
            { id: "c1", name: "Client", type: "client" },
            { id: "c2", name: "Server", type: "server" }
          ])
        );
      }
      return Promise.resolve({ status: 200, ok: false });
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("Client")).toBeInTheDocument());
    expect(screen.getByText("Server")).toBeInTheDocument();
  });
});
