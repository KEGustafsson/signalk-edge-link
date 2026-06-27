/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { PathAnalyticsCard } from "../../../../src/webapp/components/cards/PathAnalyticsCard";
import type { MetricsData } from "../../../../src/webapp/types";

function withPaths(pathStats: unknown, mode = "client"): MetricsData {
  return { mode, pathStats } as unknown as MetricsData;
}

function mkPath(i: number) {
  return {
    path: `navigation.path${i}`,
    updatesPerMinute: i,
    bytesFormatted: `${i} B`,
    percentage: 5
  };
}

describe("PathAnalyticsCard", () => {
  test("renders nothing without pathStats", () => {
    const { container } = render(<PathAnalyticsCard metrics={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("shows empty state for zero paths", () => {
    render(<PathAnalyticsCard metrics={withPaths([])} />);
    expect(screen.getByText(/No path data collected yet/)).toBeInTheDocument();
  });

  test("renders path table with summary", () => {
    render(<PathAnalyticsCard metrics={withPaths([mkPath(1), mkPath(2)])} />);
    expect(screen.getByText("Active Paths")).toBeInTheDocument();
    expect(screen.getByText("navigation.path1")).toBeInTheDocument();
  });

  test("caps table at 15 rows and shows 'showing top 15' note", () => {
    const many = Array.from({ length: 20 }, (_, i) => mkPath(i));
    render(<PathAnalyticsCard metrics={withPaths(many, "server")} />);
    expect(screen.getByText(/Showing top 15 of 20 paths/)).toBeInTheDocument();
    // header row + 15 data rows
    expect(screen.getAllByRole("row")).toHaveLength(16);
  });
});
