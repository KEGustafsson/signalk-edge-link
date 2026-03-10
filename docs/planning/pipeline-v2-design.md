# v2 Pipeline Architecture

## Approach: Parallel Pipelines

Keep v1 and v2 pipelines separate for cleaner code:

```
src/index.ts
  ├── config.protocolVersion === 1
  │   └── src/pipeline.ts (existing, unchanged)
  └── config.protocolVersion === 2
      └── src/pipeline-factory.ts
          ├── client → src/pipeline-v2-client.ts
          └── server → src/pipeline-v2-server.ts
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
src/
├── pipeline.ts              (v1 - existing, keep as-is)
├── pipeline-factory.ts      (new - version selector)
├── pipeline-v2-client.ts    (new - v2 client pipeline)
├── pipeline-v2-server.ts    (new - v2 server pipeline)
├── packet.ts                (new - packet protocol)
└── sequence.ts              (new - sequence tracking)
```

## Integration with index.ts

```typescript
// Future integration (Phase 2+):
import { createPipelineV2 } from "./pipeline-factory";

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
