const { execSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// `npm audit` hits the network, so it is skipped in the default unit-test gate
// (npm test / verify) to avoid flaking on registry/connectivity issues. A
// dedicated, non-blocking CI job sets RUN_NPM_AUDIT=1 to actually run it.
const describeAudit = process.env.RUN_NPM_AUDIT ? describe : describe.skip;

describeAudit("npm audit", () => {
  let report;

  beforeAll(() => {
    try {
      const output = execSync("npm audit --json", { cwd: ROOT, encoding: "utf8" });
      report = JSON.parse(output);
    } catch (err) {
      // npm audit exits non-zero when vulnerabilities exist; stdout still has JSON
      report = JSON.parse(err.stdout || "{}");
    }
  });

  test("no high severity vulnerabilities", () => {
    const high = report?.metadata?.vulnerabilities?.high ?? 0;
    expect(high).toBe(0);
  });

  test("no critical severity vulnerabilities", () => {
    const critical = report?.metadata?.vulnerabilities?.critical ?? 0;
    expect(critical).toBe(0);
  });

  test("total vulnerability count is zero", () => {
    const meta = report?.metadata?.vulnerabilities ?? {};
    const total = Object.values(meta).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(0);
  });
});
