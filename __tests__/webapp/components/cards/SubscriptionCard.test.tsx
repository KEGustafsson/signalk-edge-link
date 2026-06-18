/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SubscriptionCard } from "../../../../src/webapp/components/cards/SubscriptionCard";
import type { SubscriptionConfig } from "../../../../src/webapp/types";

jest.mock("../../../../src/webapp/utils/apiFetch", () => ({
  apiFetch: jest.fn(),
  getTokenHelpText: () => "",
  MANAGEMENT_TOKEN_ERROR_MESSAGE: "Management token required/invalid."
}));

const { apiFetch } = require("../../../../src/webapp/utils/apiFetch");

const baseConfig: SubscriptionConfig = {
  context: "vessels.self",
  subscribe: [{ path: "navigation.position" }]
};

describe("SubscriptionCard", () => {
  beforeEach(() => jest.clearAllMocks());

  test("renders context and existing paths from config", () => {
    render(
      <SubscriptionCard connId="c1" config={baseConfig} onNotify={() => {}} onSaved={() => {}} />
    );
    expect(screen.getByText("Subscription Configuration")).toBeInTheDocument();
    expect(screen.getByDisplayValue("vessels.self")).toBeInTheDocument();
    expect(screen.getByDisplayValue("navigation.position")).toBeInTheDocument();
  });

  test("Add Path appends an empty path input", () => {
    render(
      <SubscriptionCard connId="c1" config={baseConfig} onNotify={() => {}} onSaved={() => {}} />
    );
    const before = screen.getAllByPlaceholderText("navigation.position").length;
    fireEvent.click(screen.getByText("Add Path"));
    expect(screen.getAllByPlaceholderText("navigation.position").length).toBe(before + 1);
  });

  test("save posts config and notifies success", async () => {
    (apiFetch as jest.Mock).mockResolvedValue({ status: 200, ok: true });
    const onSaved = jest.fn();
    const onNotify = jest.fn();
    render(
      <SubscriptionCard connId="c1" config={baseConfig} onNotify={onNotify} onSaved={onSaved} />
    );

    fireEvent.click(screen.getByText("Save Subscription"));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onNotify).toHaveBeenCalledWith(expect.stringMatching(/saved successfully/i), "success");
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining("subscription.json"),
      expect.objectContaining({ method: "POST" })
    );
  });

  test("save failure notifies error", async () => {
    (apiFetch as jest.Mock).mockResolvedValue({ status: 500, ok: false });
    const onNotify = jest.fn();
    render(
      <SubscriptionCard connId="c1" config={baseConfig} onNotify={onNotify} onSaved={() => {}} />
    );

    fireEvent.click(screen.getByText("Save Subscription"));

    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(
        expect.stringMatching(/Error saving subscription/i),
        "error"
      )
    );
  });
});
