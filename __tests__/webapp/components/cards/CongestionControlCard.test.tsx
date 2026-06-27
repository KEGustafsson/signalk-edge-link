/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { CongestionControlCard } from "../../../../src/webapp/components/cards/CongestionControlCard";
import type { CongestionData } from "../../../../src/webapp/types";

function cong(overrides: Record<string, unknown>): CongestionData {
  return {
    enabled: true,
    manualMode: false,
    currentDeltaTimer: 1000,
    nominalDeltaTimer: 1000,
    minDeltaTimer: 100,
    maxDeltaTimer: 5000,
    targetRTT: 300,
    avgRTT: 120.6,
    avgLoss: 0.02,
    ...overrides
  } as unknown as CongestionData;
}

describe("CongestionControlCard", () => {
  test("renders nothing when null", () => {
    const { container } = render(<CongestionControlCard data={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("active automatic state", () => {
    render(<CongestionControlCard data={cong({})} />);
    expect(screen.getByText("Congestion Control")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("Automatic")).toBeInTheDocument();
    // avgRTT rounded
    expect(screen.getByText("121 ms")).toBeInTheDocument();
  });

  test("manual override state", () => {
    render(<CongestionControlCard data={cong({ manualMode: true })} />);
    expect(screen.getByText("manual")).toBeInTheDocument();
    expect(screen.getByText("Manual Override")).toBeInTheDocument();
  });

  test("disabled state", () => {
    render(<CongestionControlCard data={cong({ enabled: false })} />);
    expect(screen.getByText("disabled")).toBeInTheDocument();
  });
});
