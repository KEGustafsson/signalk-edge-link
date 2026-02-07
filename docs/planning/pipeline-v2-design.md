# v2 Pipeline Architecture

## Approach: Parallel Pipelines

Keep v1 and v2 pipelines separate for cleaner code:

```
index.js
  ├── config.protocolVersion === 1
  │   └── lib/pipeline.js (existing, unchanged)
  └── config.protocolVersion === 2
      └── lib/pipeline-factory.js
          ├── client → lib/pipeline-v2-client.js
          └── server → lib/pipeline-v2-server.js
```

## v2 Client Pipeline

```
Delta → Filter → PathDict Encode → Serialize → Compress → Encrypt → PacketBuild → UDP Send
                                                                        ↑
                                                              sequence number added
```

## v2 Server Pipeline

```
UDP Receive → PacketParse → SequenceTrack → Decrypt → Decompress → Parse → PathDict Decode → handleMessage
                  ↑              ↑
            header validated   gap detection, NAK scheduling
```

## File Structure

```
lib/
├── pipeline.js              (v1 - existing, keep as-is)
├── pipeline-factory.js      (new - version selector)
├── pipeline-v2-client.js    (new - v2 client pipeline)
├── pipeline-v2-server.js    (new - v2 server pipeline)
├── packet.js                (new - packet protocol)
└── sequence.js              (new - sequence tracking)
```

## Integration with index.js

```javascript
// Future integration (Phase 2+):
const { createPipelineV2 } = require('./lib/pipeline-factory');

// In plugin.start():
if (options.protocolVersion === 2) {
  state.pipeline = createPipelineV2(app, state, metricsApi);
} else {
  state.pipeline = createPipeline(app, state, metricsApi);
}
```

## Phase 1 Scope (Current)

- Pipeline factory with version selection
- Client pipeline skeleton (reuses v1 compression/encryption)
- Server pipeline skeleton (reuses v1 decryption/decompression)
- Packet building/parsing integrated
- Sequence tracking integrated
- ACK/NAK handling stubs (Phase 2)

## Phase 2 Additions

- Retransmit queue in client pipeline
- ACK/NAK packet handling
- Bidirectional UDP for ACK/NAK
- Network simulator for testing
