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
