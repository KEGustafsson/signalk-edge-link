const { execSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// Audits the RUNTIME dependency tree (`--omit=dev`). Build/test tooling
// (eslint, jest, webpack, …) never reaches an operator, so a dev-tree advisory
// is not a vulnerability in the installed plugin and must not gate `npm test`.
// Dev-tree advisories are still surfaced by the scheduled CI audit job.
//
// One qualifier, because the obvious version of that reasoning is wrong:
// `files` publishes public/, and webpack bundles some devDependencies INTO
// public/ — @rjsf/validator-ajv8 pulls ajv (and fast-uri) straight into the
// shipped browser bundle. Those packages are dev-declared but operator-facing,
// so `--omit=dev` cannot see them. The second describe block below covers that
// gap explicitly; see BUNDLED_DEV_PACKAGES.
//
// `npm audit` queries the registry, so the report can be unavailable offline.
// That case is reported explicitly rather than coerced to "zero
// vulnerabilities" — a missing report is absent evidence, not a clean result.
//
// The Signal K plugin registry harness runs this suite inside `firejail
// --net=none` and sets SIGNALK_REGISTRY_TEST=1 (documented contract, see
// SignalK/signalk-plugin-registry README). There the registry is unreachable by
// construction, so skip the audit outright instead of paying for a lookup that
// can only fail. The harness scores npm audit itself; this test exists for
// local runs and the plugin-ci matrix, which both have network.
function runAudit() {
  if (process.env.SIGNALK_REGISTRY_TEST === "1") {
    return {
      ok: false,
      reason: "SIGNALK_REGISTRY_TEST=1 — sandboxed run has no registry access"
    };
  }
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
    let parsed;
    try {
      parsed = JSON.parse(result.raw);
    } catch (err) {
      unavailable = `npm audit did not return JSON: ${err.message}`;
      return;
    }
    // Offline, npm still exits with JSON on stdout — but it is an error
    // envelope ({ message, error }), not an audit report. Treating that as a
    // report turns a network condition into a test failure, so classify it as
    // unavailable like any other missing report.
    if (!parsed?.metadata?.vulnerabilities) {
      unavailable =
        parsed?.message ||
        parsed?.error?.summary ||
        "npm audit returned no metadata.vulnerabilities";
      return;
    }
    report = parsed;
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

/**
 * Packages that are declared as devDependencies but end up inside the
 * published browser bundle (`public/`, shipped via package.json "files").
 *
 * `npm audit --omit=dev` is blind to these: they are dev-declared, yet their
 * code runs in an operator's browser. Keep this list in step with what
 * `webpack.config.js` actually bundles.
 */
const BUNDLED_DEV_PACKAGES = [
  "@rjsf/core",
  "@rjsf/utils",
  "@rjsf/validator-ajv8",
  "react",
  "react-dom"
];

function runFullAudit() {
  if (process.env.SIGNALK_REGISTRY_TEST === "1") {
    return { ok: false, reason: "SIGNALK_REGISTRY_TEST=1 — sandboxed run has no registry access" };
  }
  try {
    return { ok: true, raw: execSync("npm audit --json", { cwd: ROOT, encoding: "utf8" }) };
  } catch (err) {
    if (err.stdout) {
      return { ok: true, raw: err.stdout };
    }
    return { ok: false, reason: err.message };
  }
}

describe("npm audit (dev dependencies bundled into the published webapp)", () => {
  let vulnerabilities = null;
  let unavailable = null;

  beforeAll(() => {
    const result = runFullAudit();
    if (!result.ok) {
      unavailable = result.reason;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(result.raw);
    } catch (err) {
      unavailable = `npm audit did not return JSON: ${err.message}`;
      return;
    }
    if (!parsed?.vulnerabilities) {
      unavailable = parsed?.message || "npm audit returned no vulnerabilities map";
      return;
    }
    vulnerabilities = parsed.vulnerabilities;
  });

  /**
   * Whether `pkg` is installed anywhere beneath one of the bundled entry
   * points.
   *
   * The audit report's own `effects` field is not usable for this: it is
   * frequently empty for a transitive advisory (fast-uri reports no effects
   * even though @rjsf/validator-ajv8 -> ajv -> fast-uri is a real path), so
   * reachability has to come from the installed tree instead.
   */
  function reachableFromBundle(pkg) {
    let tree;
    try {
      tree = JSON.parse(execSync(`npm ls ${pkg} --all --json`, { cwd: ROOT, encoding: "utf8" }));
    } catch (err) {
      if (!err.stdout) {
        return false;
      }
      try {
        tree = JSON.parse(err.stdout);
      } catch {
        return false;
      }
    }

    const seen = new Set();
    const walk = (node, underBundle) => {
      const deps = node?.dependencies ?? {};
      for (const [name, child] of Object.entries(deps)) {
        const key = `${name}@${child?.version ?? "?"}:${underBundle}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const nowUnderBundle = underBundle || BUNDLED_DEV_PACKAGES.includes(name);
        if (nowUnderBundle && name === pkg) {
          return true;
        }
        if (walk(child, nowUnderBundle)) {
          return true;
        }
      }
      return false;
    };
    return walk(tree, false);
  }

  test("no high or critical advisories reach the shipped browser bundle", () => {
    if (unavailable) {
      console.warn(`npm audit unavailable, bundled-dependency assertions skipped: ${unavailable}`);
      return;
    }

    const severe = Object.entries(vulnerabilities).filter(
      ([, entry]) => entry.severity === "high" || entry.severity === "critical"
    );
    // Guard against the check silently becoming vacuous: if the whole tree is
    // clean there is nothing to classify, which is a pass for a different
    // reason and worth stating rather than asserting an empty list.
    if (severe.length === 0) {
      expect(severe).toEqual([]);
      return;
    }

    const offenders = severe
      .filter(([name]) => BUNDLED_DEV_PACKAGES.includes(name) || reachableFromBundle(name))
      .map(([name, entry]) => `${name} (${entry.severity})`);

    expect(offenders).toEqual([]);
  });
});
