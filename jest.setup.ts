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
