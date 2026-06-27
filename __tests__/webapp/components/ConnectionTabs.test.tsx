/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectionTabs } from "../../../src/webapp/components/ConnectionTabs";

const connections = [
  { id: "c1", name: "Alpha", type: "client" as const, readyToSend: true },
  { id: "c2", name: "Beta", type: "server" as const }
];

describe("ConnectionTabs", () => {
  test("renders nothing for single connection", () => {
    const { container } = render(
      <ConnectionTabs connections={[connections[0]]} activeId="c1" onSelect={jest.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders tab buttons for multiple connections", () => {
    render(<ConnectionTabs connections={connections} activeId="c1" onSelect={jest.fn()} />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  test("active tab has active class", () => {
    render(<ConnectionTabs connections={connections} activeId="c2" onSelect={jest.fn()} />);
    const tabs = screen.getAllByRole("button");
    expect(tabs[1].className).toContain("active");
    expect(tabs[0].className).not.toContain("active");
  });

  test("calls onSelect when a tab is clicked", () => {
    const onSelect = jest.fn();
    render(<ConnectionTabs connections={connections} activeId="c1" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Beta"));
    expect(onSelect).toHaveBeenCalledWith("c2");
  });

  test("unhealthy connection shows error dot", () => {
    const conns = [
      { id: "c1", name: "A", type: "client" as const, healthy: false },
      { id: "c2", name: "B", type: "server" as const }
    ];
    const { container } = render(
      <ConnectionTabs connections={conns} activeId="c1" onSelect={jest.fn()} />
    );
    const dots = container.querySelectorAll(".tab-status-dot");
    expect(dots[0].className).toContain("error");
  });
});
