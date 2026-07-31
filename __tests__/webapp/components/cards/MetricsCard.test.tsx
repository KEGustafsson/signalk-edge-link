/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { MetricsCard } from "../../../../src/webapp/components/cards/MetricsCard";
import type { MetricsData } from "../../../../src/webapp/types";

const baseMetrics: MetricsData = {
  mode: "client",
  protocolVersion: 1,
  stats: {
    deltasSent: 1000,
    deltasReceived: 0,
    udpSendErrors: 0,
    udpRetries: 5,
    compressionErrors: 0,
    encryptionErrors: 0,
    subscriptionErrors: 0,
    malformedPackets: 0
  },
  status: { readyToSend: true, deltasBuffered: 3 },
  uptime: { formatted: "2h 15m" }
};

describe("MetricsCard", () => {
  test("shows loading state when metrics is null", () => {
    render(<MetricsCard metrics={null} />);
    expect(screen.getByText("Loading metrics...")).toBeInTheDocument();
  });

  test("renders client metrics", () => {
    render(<MetricsCard metrics={baseMetrics} />);
    expect(screen.getByText("2h 15m")).toBeInTheDocument();
    expect(screen.getByText("Client")).toBeInTheDocument();
    expect(screen.getByText("V1")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  test("renders server metrics", () => {
    const serverMetrics: MetricsData = {
      ...baseMetrics,
      mode: "server",
      stats: { ...baseMetrics.stats, deltasReceived: 500, deltasSent: 0 }
    };
    render(<MetricsCard metrics={serverMetrics} />);
    expect(screen.getByText("Server")).toBeInTheDocument();
    expect(screen.getByText(/500/)).toBeInTheDocument();
  });

  test("shows no errors message when clean", () => {
    render(<MetricsCard metrics={baseMetrics} />);
    expect(screen.getByText("No errors detected")).toBeInTheDocument();
  });

  test("shows v3 auth failure stat for protocol >= 3", () => {
    const v3: MetricsData = {
      ...baseMetrics,
      protocolVersion: 3,
      stats: { ...baseMetrics.stats, errorCounts: { crypto: 2 } }
    };
    render(<MetricsCard metrics={v3} />);
    expect(screen.getByText("Auth Failures (V3):")).toBeInTheDocument();
  });

  // A client can look completely healthy while dropping every ACK: deltas go
  // out, no errors are raised, and only the retransmit queue quietly grows.
  // Surfacing the counter is what turns that into something an operator can
  // see, so it must be present at zero — an absent row proves nothing.
  test("always surfaces rejected control packets on a client", () => {
    render(<MetricsCard metrics={baseMetrics} />);
    expect(screen.getByText(/Rejected Control Packets/)).toBeInTheDocument();
  });

  test("flags rejected control packets as an error when non-zero", () => {
    const rejecting: MetricsData = {
      ...baseMetrics,
      stats: { ...baseMetrics.stats, rejectedControlPackets: 17 }
    };
    render(<MetricsCard metrics={rejecting} />);

    // The count alone proves only that a number rendered. The behaviour under
    // test is the error flag StatItem receives.
    const row = screen.getByText(/Rejected Control Packets/).closest(".stat-item");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("17");
    expect(row?.className).toContain("error");
  });

  // The counter has to feed the card's overall verdict too, or the card shows
  // a red "Rejected Control Packets: 17" and "No errors detected" side by side.
  test("a non-zero count suppresses the no-errors message", () => {
    const rejecting: MetricsData = {
      ...baseMetrics,
      stats: { ...baseMetrics.stats, rejectedControlPackets: 17 }
    };
    render(<MetricsCard metrics={rejecting} />);

    expect(screen.queryByText(/No errors detected/i)).not.toBeInTheDocument();
  });

  test("shows recent errors list", () => {
    const withErrors: MetricsData = {
      ...baseMetrics,
      recentErrors: [{ category: "encryption", message: "Bad key", timestamp: Date.now() - 5000 }]
    };
    render(<MetricsCard metrics={withErrors} />);
    expect(screen.getByText("Bad key")).toBeInTheDocument();
    expect(screen.getByText("encryption")).toBeInTheDocument();
  });
});
