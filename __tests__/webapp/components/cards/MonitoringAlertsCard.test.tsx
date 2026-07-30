/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { MonitoringAlertsCard } from "../../../../src/webapp/components/cards/MonitoringAlertsCard";
import type { MonitoringData } from "../../../../src/webapp/types";

describe("MonitoringAlertsCard", () => {
  test("renders nothing when null or empty", () => {
    const { container } = render(<MonitoringAlertsCard data={null} />);
    expect(container).toBeEmptyDOMElement();
    const { container: c2 } = render(<MonitoringAlertsCard data={{} as MonitoringData} />);
    expect(c2).toBeEmptyDOMElement();
  });

  test("shows 'No active alerts' when alerts object has none", () => {
    render(
      <MonitoringAlertsCard data={{ alerts: { activeAlerts: {} } } as unknown as MonitoringData} />
    );
    expect(screen.getByText("No active alerts")).toBeInTheDocument();
  });

  test("renders active alerts with normalised levels", () => {
    const data = {
      alerts: {
        activeAlerts: {
          rtt: { level: "alert", value: 900 },
          jitter: "warn"
        }
      }
    } as unknown as MonitoringData;
    render(<MonitoringAlertsCard data={data} />);
    expect(screen.getByText("CRITICAL (900)")).toBeInTheDocument();
    expect(screen.getByText("WARNING")).toBeInTheDocument();
  });

  // This previously fed the card a hand-written shape invented to match what
  // the card read, so it passed while every number in the real UI was a
  // permanent 0. The producers are the contract, so drive their actual output
  // through the card: a field rename on either side now fails here.
  test("renders the real tracker summaries, not zeros", () => {
    const {
      PacketLossTracker,
      RetransmissionTracker
    } = require("../../../../lib/domain/monitoring");

    jest.useFakeTimers();
    let data;
    try {
      const loss = new PacketLossTracker();
      for (let i = 0; i < 92; i++) loss.record(false);
      for (let i = 0; i < 8; i++) loss.record(true); // 8 lost of 100 observed
      // The in-progress bucket is excluded until it closes, so cross a bucket
      // boundary (5s) or the summary is legitimately empty.
      jest.advanceTimersByTime(6000);

      const rtx = new RetransmissionTracker();
      rtx.snapshot(0, 0);
      // snapshot() ignores a zero-elapsed call, so time must move between them.
      jest.advanceTimersByTime(1000);
      rtx.snapshot(1000, 30); // 30 retransmissions over 1000 packets

      data = {
        packetLoss: { summary: loss.getSummary() },
        retransmissions: { summary: rtx.getSummary() }
      } as unknown as MonitoringData;
    } finally {
      jest.useRealTimers();
    }

    render(<MonitoringAlertsCard data={data} />);

    expect(screen.getByText("Packet Loss")).toBeInTheDocument();
    expect(screen.getByText("Retransmissions")).toBeInTheDocument();
    // The counts must survive the trip. Asserting the rendered values (not just
    // that a label exists) is the whole point: the labels rendered fine before.
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(screen.getByText("8.0%")).toBeInTheDocument();
    expect(screen.getByText("3.0%")).toBeInTheDocument();
  });

  test("renders partial packet loss and retransmission data without crashing", () => {
    const data = {
      packetLoss: { summary: {} },
      retransmissions: { summary: {} }
    } as unknown as MonitoringData;

    render(<MonitoringAlertsCard data={data} />);

    expect(screen.getByText("Packet Loss")).toBeInTheDocument();
    expect(screen.getByText("Retransmissions")).toBeInTheDocument();
    expect(screen.getAllByText("0.0%")).toHaveLength(2);
  });
});
