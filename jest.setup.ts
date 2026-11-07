import "@testing-library/jest-dom";

// In the jsdom (webapp) environment, treat React "not wrapped in act(...)"
// warnings as hard failures so async hook/state updates are always flushed
// inside act(). Scoped to jsdom (window defined) so Node-environment tests that
// legitimately log via console.error are unaffected; all other console.error
// output is passed through unchanged.
if (typeof window !== "undefined") {
  const originalError = console.error.bind(console);
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => {
    const first = typeof args[0] === "string" ? args[0] : "";
    if (first.includes("not wrapped in act")) {
      throw new Error(`Unwrapped React state update (act warning): ${first}`);
    }
    originalError(...(args as Parameters<typeof originalError>));
  };
}

// Track Brotli operations still running on the libuv threadpool. Fleet
// packets are compressed and decompressed asynchronously, so a test harness
// that moves packets by hand needs to know when the work in flight has
// finished (`pump` in __tests__/helpers/fleet-harness.js). The wrapper only
// records each operation; results and errors pass through unchanged. zlib is
// a core module shared by every test file in the worker, so it is wrapped once.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const zlibModule = require("node:zlib") as Record<string, unknown> & {
  edgeLinkBrotliInFlight?: Set<number>;
};
if (!zlibModule.edgeLinkBrotliInFlight) {
  const inFlight = new Set<number>();
  let nextId = 0;
  zlibModule.edgeLinkBrotliInFlight = inFlight;
  for (const name of ["brotliCompress", "brotliDecompress"]) {
    const original = zlibModule[name] as (...args: unknown[]) => unknown;
    zlibModule[name] = function tracked(this: unknown, ...args: unknown[]): unknown {
      const done = args[args.length - 1];
      if (typeof done !== "function") {
        return original.apply(this, args);
      }
      const id = nextId++;
      inFlight.add(id);
      args[args.length - 1] = (err: unknown, result: unknown) => {
        inFlight.delete(id);
        (done as (e: unknown, r: unknown) => void)(err, result);
      };
      return original.apply(this, args);
    };
  }
}
