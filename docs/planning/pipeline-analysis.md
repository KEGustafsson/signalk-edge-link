# Current Pipeline Analysis

## v1.0 Pipeline Flow (Client Side - `packCrypt`)

1. Signal K Delta received (JSON object or array)
2. Path Dictionary Encode (optional, via `pathDictionary.encodeDelta`)
3. Serialize to Buffer (JSON or MessagePack)
4. Brotli Compress (quality 10)
5. AES-256-GCM Encrypt (via `crypto.encryptBinary`)
6. MTU check and smart batching metrics
7. UDP Send (with retry logic)

## v1.0 Pipeline Flow (Server Side - `unpackDecrypt`)

1. UDP Receive (binary packet)
2. AES-256-GCM Decrypt (via `crypto.decryptBinary`)
3. Brotli Decompress
4. Parse (JSON or MessagePack with fallback)
5. Path Dictionary Decode (via `pathDictionary.decodeDelta`)
6. `app.handleMessage()` for each delta

## Key Architecture Details

- Pipeline is created via factory: `createPipeline(app, state, metricsApi)`
- Returns `{ packCrypt, unpackDecrypt }` - two functions
- Uses shared `state` object for options, socket, batching vars
- UDP send has retry logic (3 retries with exponential backoff)
- Smart batching: tracks bytes-per-delta to prevent MTU fragmentation

## Integration Points for v2

### Where to Insert Packet Layer

**Client Side**: After encrypt, before UDP send
```
... → Encrypt → **Packet Build** → UDP Send
```

**Server Side**: After UDP receive, before decrypt
```
UDP Receive → **Packet Parse + Sequence Track** → Decrypt → ...
```

### Required Changes

1. Create `lib/pipeline-factory.js` - version selector
2. Create `lib/pipeline-v2-client.js` - v2 client pipeline
3. Create `lib/pipeline-v2-server.js` - v2 server pipeline
4. Keep `lib/pipeline.js` as-is for v1 backward compatibility

### Design Decision: Parallel Pipelines

Keep v1 and v2 pipelines completely separate:
- Cleaner code, no version checks scattered everywhere
- Easy to test independently
- No risk of breaking v1
- Can remove v1 in future v3.0
