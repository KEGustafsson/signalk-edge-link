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

  test("renders packet loss and retransmission subsections", () => {
    const data = {
      packetLoss: { summary: { totalLost: 5, totalExpected: 100, lossRate: 0.05 } },
      retransmissions: { totalRetransmissions: 3, retransmitRate: 0.03 }
    } as unknown as MonitoringData;
    render(<MonitoringAlertsCard data={data} />);
    expect(screen.getByText("Packet Loss")).toBeInTheDocument();
    expect(screen.getByText("Retransmissions")).toBeInTheDocument();
    expect(screen.getByText(/Total Lost/)).toBeInTheDocument();
  });

  test("renders partial packet loss and retransmission data without crashing", () => {
    const data = {
      packetLoss: { summary: {} },
      retransmissions: {}
    } as unknown as MonitoringData;

    render(<MonitoringAlertsCard data={data} />);

    expect(screen.getByText("Packet Loss")).toBeInTheDocument();
    expect(screen.getByText("Retransmissions")).toBeInTheDocument();
    expect(screen.getAllByText("0.0%")).toHaveLength(2);
  });
});
