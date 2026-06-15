/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { BondingCard } from "../../../../src/webapp/components/cards/BondingCard";
import type { BondingData } from "../../../../src/webapp/types";

describe("BondingCard", () => {
  test("renders nothing when disabled or null", () => {
    const { container } = render(<BondingCard data={null} onFailover={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    const { container: c2 } = render(
      <BondingCard data={{ enabled: false } as BondingData} onFailover={() => {}} />
    );
    expect(c2).toBeEmptyDOMElement();
  });

  test("renders links, active badge and down status", () => {
    const data = {
      enabled: true,
      mode: "main-backup",
      activeLink: "primary",
      links: {
        primary: { status: "active", rtt: 40, loss: 0.01 },
        backup: { status: "down", rtt: 0, loss: 1 }
      }
    } as unknown as BondingData;
    render(<BondingCard data={data} onFailover={() => {}} />);
    expect(screen.getByText("Connection Bonding")).toBeInTheDocument();
    expect(screen.getByText("main backup")).toBeInTheDocument();
    // "ACTIVE" appears both as the active badge and the uppercased status.
    expect(screen.getAllByText("ACTIVE").length).toBeGreaterThan(0);
    expect(screen.getByText("DOWN")).toBeInTheDocument();
  });

  test("Force Failover button calls handler", () => {
    const onFailover = jest.fn();
    render(
      <BondingCard
        data={{ enabled: true, activeLink: "primary" } as BondingData}
        onFailover={onFailover}
      />
    );
    fireEvent.click(screen.getByText("Force Failover"));
    expect(onFailover).toHaveBeenCalledTimes(1);
  });
});
