const { execSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Opt-in only: npm audit hits the network/registry, so it would make the
// default Jest suite slow and flaky. CI runs it in a dedicated step with
// RUN_NPM_AUDIT=1 (see .github/workflows/ci.yml).
const describeAudit = process.env.RUN_NPM_AUDIT === "1" ? describe : describe.skip;

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
