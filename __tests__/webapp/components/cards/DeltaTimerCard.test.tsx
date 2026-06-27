/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DeltaTimerCard } from "../../../../src/webapp/components/cards/DeltaTimerCard";

jest.mock("../../../../src/webapp/utils/apiFetch", () => ({
  apiFetch: jest.fn(),
  getTokenHelpText: () => "",
  MANAGEMENT_TOKEN_ERROR_MESSAGE: "Management token required/invalid."
}));

const { apiFetch } = require("../../../../src/webapp/utils/apiFetch");

describe("DeltaTimerCard", () => {
  beforeEach(() => jest.clearAllMocks());

  test("renders with loaded config value", () => {
    render(
      <DeltaTimerCard
        connId="c1"
        config={{ deltaTimer: 2000 }}
        onNotify={jest.fn()}
        onSaved={jest.fn()}
      />
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("2000");
  });

  test("save button calls API and notifies success", async () => {
    (apiFetch as jest.Mock).mockResolvedValue({ status: 200, ok: true });
    const onSaved = jest.fn();
    const onNotify = jest.fn();

    render(
      <DeltaTimerCard
        connId="c1"
        config={{ deltaTimer: 1000 }}
        onNotify={onNotify}
        onSaved={onSaved}
      />
    );

    fireEvent.click(screen.getByText("Save Delta Timer"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ deltaTimer: 1000 }));
    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining("saved"), "success");
  });

  test("shows error notification for out-of-range value", async () => {
    const onNotify = jest.fn();
    render(
      <DeltaTimerCard
        connId="c1"
        config={{ deltaTimer: 1000 }}
        onNotify={onNotify}
        onSaved={jest.fn()}
      />
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.click(screen.getByText("Save Delta Timer"));

    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(expect.stringContaining("between"), "error")
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
