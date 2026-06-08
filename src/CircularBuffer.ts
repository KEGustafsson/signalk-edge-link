// CircularBuffer uses `export =`, so the shim must forward it the same way.
import CircularBuffer = require("./foundation/circular-buffer");
export = CircularBuffer;
