/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { BandwidthCard } from "../../../../src/webapp/components/cards/BandwidthCard";
import type { MetricsData } from "../../../../src/webapp/types";

function bwMetrics(bw: Record<string, unknown>, mode = "client"): MetricsData {
  return { mode, bandwidth: bw } as unknown as MetricsData;
}

const base = {
  rateOutFormatted: "8 KB/s",
  rateInFormatted: "3 KB/s",
  compressionRatio: 50,
  avgPacketSizeFormatted: "180 B",
  bytesOut: 500,
  bytesOutRaw: 1000,
  bytesIn: 200,
  bytesInRaw: 400,
  bytesOutFormatted: "500 B",
  bytesOutRawFormatted: "1 KB",
  bytesInFormatted: "200 B",
  packetsOut: 10,
  packetsIn: 8
};

describe("BandwidthCard", () => {
  test("renders nothing without bandwidth data", () => {
    const { container } = render(<BandwidthCard metrics={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("client view shows upload rate, compression and sent totals", () => {
    render(<BandwidthCard metrics={bwMetrics(base)} />);
    expect(screen.getByText("Bandwidth Monitor")).toBeInTheDocument();
    expect(screen.getByText("Upload Rate")).toBeInTheDocument();
    expect(screen.getByText("8 KB/s")).toBeInTheDocument();
    expect(screen.getByText(/Total Sent \(Compressed\)/)).toBeInTheDocument();
    expect(screen.getByText(/Metadata Sent/)).toBeInTheDocument();
  });

  test("server view shows download rate and received totals", () => {
    render(<BandwidthCard metrics={bwMetrics(base, "server")} />);
    expect(screen.getByText("Download Rate")).toBeInTheDocument();
    expect(screen.getByText(/Total Received \(Compressed\)/)).toBeInTheDocument();
    expect(screen.getByText(/Metadata Received/)).toBeInTheDocument();
  });

  test("sparkline placeholder shows with <2 history points", () => {
    render(
      <BandwidthCard metrics={bwMetrics({ ...base, history: [{ rateOut: 1, rateIn: 1 }] })} />
    );
    expect(screen.getByText(/Collecting data for chart/)).toBeInTheDocument();
  });

  test("sparkline renders with >=2 history points", () => {
    render(
      <BandwidthCard
        metrics={bwMetrics({
          ...base,
          history: [
            { rateOut: 1, rateIn: 2 },
            { rateOut: 3, rateIn: 4 }
          ]
        })}
      />
    );
    expect(screen.getByText(/Rate History/)).toBeInTheDocument();
  });
});
