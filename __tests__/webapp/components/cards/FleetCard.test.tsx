/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { FleetCard } from "../../../../src/webapp/components/cards/FleetCard";
import type { FleetMetricsData } from "../../../../src/webapp/types";

function fleet(overrides: Partial<FleetMetricsData> = {}): FleetMetricsData {
  return {
    members: 0,
    packetsSent: 0,
    bytesSent: 0,
    valuesSent: 0,
    retransmits: 0,
    rateLimitedFlushes: 0,
    originDrops: 0,
    identityConflicts: 0,
    identityRejected: 0,
    keepalivesSent: 0,
    snapshotsSent: 0,
    staleStreamPackets: 0,
    packetsAbandoned: 0,
    rateBackoffs: 0,
    minRateFactor: 1,
    state: "disabled",
    packetsReceived: 0,
    valuesReceived: 0,
    metaReceived: 0,
    contextsKnown: 0,
    loopDrops: 0,
    duplicatePackets: 0,
    staleValues: 0,
    rejectedPackets: 0,
    acksSent: 0,
    naksSent: 0,
    ...overrides
  };
}

describe("FleetCard", () => {
  test("renders nothing when fleet sharing is not running", () => {
    const { container } = render(<FleetCard fleet={null} mode="client" />);
    expect(container).toBeEmptyDOMElement();
  });

  test.each([
    ["declined", /Enable fleetSharing on the server/],
    ["not-offered", /unreachable.*before 4\.4\.0/],
    ["offered", /MMSI, UUID or Signal K self/],
    ["active", /Receiving other vessels/]
  ] as const)("client state %s shows its next step", (state, hint) => {
    render(<FleetCard fleet={fleet({ state, contextsKnown: 2 })} mode="client" />);
    expect(screen.getByText(state)).toBeInTheDocument();
    expect(screen.getByTestId("fleet-hint").textContent).toMatch(hint);
  });

  test("server view shows members and explains reduced pacing", () => {
    render(
      <FleetCard
        fleet={fleet({ members: 3, minRateFactor: 0.49, rateBackoffs: 2 })}
        mode="server"
      />
    );
    expect(screen.getByText("Members")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("49%")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-hint").textContent).toMatch(/cut to 49%/);
  });

  test("server view shows its state, and a stopped server reads disabled", () => {
    const { rerender } = render(
      <FleetCard fleet={fleet({ state: "active", members: 2 })} mode="server" />
    );
    expect(screen.getByText("active")).toBeInTheDocument();
    rerender(<FleetCard fleet={fleet({ state: "disabled", members: 0 })} mode="server" />);
    expect(screen.getByText("disabled")).toBeInTheDocument();
  });

  test("server view labels refused identities and does not flag identity conflicts", () => {
    render(
      <FleetCard fleet={fleet({ identityConflicts: 2, identityRejected: 1 })} mode="server" />
    );
    expect(screen.getByText(/^Refused identities/)).toBeInTheDocument();
    const conflicts = screen.getByText(/^Identity conflicts/).parentElement;
    expect(conflicts?.className ?? "").not.toMatch(/error/);
  });

  test("server view has no pacing hint at full rate", () => {
    render(<FleetCard fleet={fleet({ members: 2 })} mode="server" />);
    expect(screen.queryByTestId("fleet-hint")).toBeNull();
  });
});
