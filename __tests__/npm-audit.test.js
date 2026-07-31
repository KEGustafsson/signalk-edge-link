const { execSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Audits the RUNTIME dependency tree only (`--omit=dev`). Build/test tooling
// (eslint, jest, webpack, rjsf, …) never reaches an operator: package.json
// "files" publishes lib/ and public/ only, so a dev-tree advisory is not a
// vulnerability in the installed plugin and must not gate `npm test`.
// Dev-tree advisories are still surfaced by the scheduled CI audit job.
//
// `npm audit` queries the registry, so the report can be unavailable offline.
// That case is reported explicitly rather than coerced to "zero
// vulnerabilities" — a missing report is absent evidence, not a clean result.
function runAudit() {
  try {
    return {
      ok: true,
      raw: execSync("npm audit --omit=dev --json", { cwd: ROOT, encoding: "utf8" })
    };
  } catch (err) {
    // npm audit exits non-zero when vulnerabilities exist; stdout still has JSON.
    if (err.stdout) {
      return { ok: true, raw: err.stdout };
    }
    return { ok: false, reason: err.message };
  }
}

// Severity buckets only. `metadata.vulnerabilities` also carries a `total`
// key, so summing every value double-counts.
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];

describe("npm audit (runtime dependencies)", () => {
  let report = null;
  let unavailable = null;

  beforeAll(() => {
    const result = runAudit();
    if (!result.ok) {
      unavailable = result.reason;
      return;
    }
    try {
      report = JSON.parse(result.raw);
    } catch (err) {
      unavailable = `npm audit did not return JSON: ${err.message}`;
    }
  });

  test("audit report is available", () => {
    if (unavailable) {
      // Offline/registry failure: warn loudly instead of reporting a false pass,
      // but do not fail the suite on a network condition.
      console.warn(`npm audit unavailable, advisory assertions skipped: ${unavailable}`);
      return;
    }
    expect(report?.metadata?.vulnerabilities).toBeDefined();
  });

  test("no high severity vulnerabilities", () => {
    if (unavailable) {
      return;
    }
    expect(report?.metadata?.vulnerabilities?.high ?? 0).toBe(0);
  });

  test("no critical severity vulnerabilities", () => {
    if (unavailable) {
      return;
    }
    expect(report?.metadata?.vulnerabilities?.critical ?? 0).toBe(0);
  });

  test("total vulnerability count is zero", () => {
    if (unavailable) {
      return;
    }
    const meta = report?.metadata?.vulnerabilities ?? {};
    const total = SEVERITIES.reduce((sum, key) => sum + (meta[key] ?? 0), 0);
    expect(total).toBe(0);
  });
});
