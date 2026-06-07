// Re-export shim — see src/foundation/circular-buffer.ts (rewrite doc 05).
// CircularBuffer uses `export =`, so the shim must forward it the same way.
import CircularBuffer = require("./foundation/circular-buffer");
export = CircularBuffer;
