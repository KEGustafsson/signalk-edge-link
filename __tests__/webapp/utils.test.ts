import {
  formatBytes,
  formatRatioPercent,
  formatTimestampAge,
  metricsPath,
  configPath,
  monitoringPath
} from "../../src/webapp/utils";

describe("formatBytes", () => {
  test("returns '0 B' for zero or negative", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });

  test("returns '0 B' for non-finite values", () => {
    expect(formatBytes(Infinity)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
  });

  test("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1048576)).toBe("1 MB");
    expect(formatBytes(1073741824)).toBe("1 GB");
  });

  test("formats fractional KB", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});

describe("formatRatioPercent", () => {
  test("returns '0.0%' for non-finite or non-positive", () => {
    expect(formatRatioPercent(0)).toBe("0.0%");
    expect(formatRatioPercent(-0.1)).toBe("0.0%");
    expect(formatRatioPercent(NaN)).toBe("0.0%");
  });

  test("formats ratio as percentage", () => {
    expect(formatRatioPercent(0.055)).toBe("5.5%");
    expect(formatRatioPercent(1)).toBe("100.0%");
  });
});

describe("formatTimestampAge", () => {
  test("returns 'N/A' for invalid timestamps", () => {
    expect(formatTimestampAge(0)).toBe("N/A");
    expect(formatTimestampAge(-1)).toBe("N/A");
  });

  test("returns 'just now' for recent timestamps", () => {
    expect(formatTimestampAge(Date.now() - 500)).toBe("just now");
  });

  test("returns seconds for < 1 minute", () => {
    expect(formatTimestampAge(Date.now() - 30000)).toBe("30s ago");
  });

  test("returns minutes for < 1 hour", () => {
    expect(formatTimestampAge(Date.now() - 120000)).toBe("2m ago");
  });
});

describe("API path helpers", () => {
  test("metricsPath uses /metrics for legacy", () => {
    expect(metricsPath("_legacy")).toBe("/plugins/signalk-edge-link/metrics");
  });

  test("metricsPath includes connId for non-legacy", () => {
    expect(metricsPath("conn-1")).toBe("/plugins/signalk-edge-link/connections/conn-1/metrics");
  });

  test("configPath encodes connId", () => {
    expect(configPath("my conn", "delta_timer.json")).toBe(
      "/plugins/signalk-edge-link/connections/my%20conn/config/delta_timer.json"
    );
  });

  test("configPath encodes filename", () => {
    expect(configPath("my conn", "a/b?.json")).toBe(
      "/plugins/signalk-edge-link/connections/my%20conn/config/a%2Fb%3F.json"
    );
  });

  test("monitoringPath encodes sub", () => {
    expect(monitoringPath("my conn", "latency/avg")).toBe(
      "/plugins/signalk-edge-link/connections/my%20conn/monitoring/latency%2Favg"
    );
  });
});
