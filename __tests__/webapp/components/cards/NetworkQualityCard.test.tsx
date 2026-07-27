/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { NetworkQualityCard } from "../../../../src/webapp/components/cards/NetworkQualityCard";
import type { MetricsData } from "../../../../src/webapp/types";

function metrics(nq: Record<string, unknown>, mode = "client"): MetricsData {
  return { mode, networkQuality: nq } as unknown as MetricsData;
}

describe("NetworkQualityCard", () => {
  test("renders nothing when metrics or networkQuality is missing", () => {
    const { container } = render(<NetworkQualityCard metrics={null} />);
    expect(container).toBeEmptyDOMElement();
    const { container: c2 } = render(
      <NetworkQualityCard metrics={{ mode: "client" } as MetricsData} />
    );
    expect(c2).toBeEmptyDOMElement();
  });

  test("client view shows excellent quality and key metrics", () => {
    render(
      <NetworkQualityCard
        metrics={metrics({ linkQuality: 95, rtt: 40, jitter: 5, packetLoss: 0.01, queueDepth: 2 })}
      />
    );
    expect(screen.getByText("Network Quality")).toBeInTheDocument();
    expect(screen.getByText("Excellent")).toBeInTheDocument();
    expect(screen.getByText("40 ms")).toBeInTheDocument();
    expect(screen.getByText(/Queue Depth/)).toBeInTheDocument();
  });

  test.each([
    [95, "Excellent"],
    [75, "Good"],
    [55, "Fair"],
    [10, "Poor"]
  ])("quality %i maps to %s", (q, label) => {
    render(<NetworkQualityCard metrics={metrics({ linkQuality: q })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  // An unmeasured link used to render a green 100 "Excellent". It now reads
  // N/A, and says which of the two reasons applies so the operator is not left
  // guessing whether the panel itself is broken.
  test("an unmeasured client link explains that no round trip has been timed", () => {
    render(<NetworkQualityCard metrics={metrics({ packetLoss: 0, queueDepth: 184 })} />);

    // Gauge label plus the RTT and jitter tiles.
    expect(screen.getAllByText("N/A").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("\u2014")).toBeInTheDocument();
    expect(screen.getByText("No round trip measured yet")).toBeInTheDocument();
    // The locally-observed queue depth is real and must still be shown.
    expect(screen.getByText("184")).toBeInTheDocument();
  });

  test("an unmeasured server link points at missing client telemetry", () => {
    render(<NetworkQualityCard metrics={metrics({ packetLoss: 0 }, "server")} />);

    expect(screen.getAllByText("N/A").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("Awaiting client telemetry")).toBeInTheDocument();
  });

  test("no reason line is shown once the link has been measured", () => {
    render(<NetworkQualityCard metrics={metrics({ linkQuality: 95, rtt: 40, jitter: 5 })} />);

    expect(screen.queryByText("No round trip measured yet")).not.toBeInTheDocument();
    expect(screen.queryByText("Awaiting client telemetry")).not.toBeInTheDocument();
  });

  test("server view shows ACK/NAK stats and N/A for missing values", () => {
    render(<NetworkQualityCard metrics={metrics({ acksSent: 12, naksSent: 3 }, "server")} />);
    expect(screen.getByText(/ACKs Sent/)).toBeInTheDocument();
    expect(screen.getByText(/NAKs Sent/)).toBeInTheDocument();
    // rtt/jitter missing → N/A
    expect(screen.getAllByText("N/A").length).toBeGreaterThan(0);
  });

  test("shows active link and last remote update when present", () => {
    render(
      <NetworkQualityCard
        metrics={metrics({ linkQuality: 80, activeLink: "backup", lastRemoteUpdate: Date.now() })}
      />
    );
    expect(screen.getByText(/Active Link/)).toBeInTheDocument();
    expect(screen.getByText("backup")).toBeInTheDocument();
    expect(screen.getByText(/Last Remote Update/)).toBeInTheDocument();
  });
});
