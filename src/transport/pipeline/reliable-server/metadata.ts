"use strict";

/**
 * Signal K Edge Link - Reliable Server Pipeline: METADATA packet handling
 *
 * Envelope sequence dedup/stale-drop and decode/dispatch of METADATA (0x06)
 * packets (metadata entries and source snapshots).
 *
 * @module transport/pipeline/reliable-server/metadata
 */

import { promisify } from "util";
import zlib from "node:zlib";
import * as msgpack from "@msgpack/msgpack";
import { decryptBinary } from "../../../codec/crypto";
import { DecryptError } from "../../../foundation/result";
import { decodeMetaEntry } from "../../../codec/path-dictionary";
import { mergeSourceSnapshot } from "../../../codec/source-snapshot";
import { ParsedPacket } from "../../../codec/packet-codec";
import { getOrCreateSession } from "./sessions";
import type { ServerContext, ClientSession } from "./context";
import type { Delta } from "../../../foundation/types";

import { MAX_DECOMPRESSED_SIZE, MAX_PARSE_PAYLOAD_SIZE } from "../../../foundation/constants";

const brotliDecompressAsync = promisify(zlib.brotliDecompress);

interface MetaEnvelope {
  v?: number;
  kind?: string;
  seq?: number;
  idx?: number;
  total?: number;
  sources?: Record<string, unknown>;
  entries?: Array<{
    context?: string;
    path?: string | number;
    meta?: Record<string, unknown>;
  }>;
}

/**
 * Two-level envelope dedup for META / source-snapshot channels. Returns true
 * when the envelope chunk should be dropped (stale batch, exact-replay chunk,
 * or chunk-index cap reached). Mutates the per-session dedup state in place.
 */
export function shouldDropEnvelopeBySeq(
  ctx: ServerContext,
  session: ClientSession | null | undefined,
  env: { seq?: number; idx?: number },
  channel: "META" | "source snapshot"
): boolean {
  const { app, metrics, META_RESTART_THRESHOLD, MAX_ENVELOPE_CHUNK_INDICES } = ctx;
  if (!session || typeof env.seq !== "number" || !Number.isFinite(env.seq)) {
    return false;
  }

  const envSeq = env.seq >>> 0;
  const envIdx = typeof env.idx === "number" && Number.isFinite(env.idx) ? env.idx >>> 0 : 0;
  const isSource = channel === "source snapshot";
  const seenChunkIdx = isSource ? session.seenSourceChunkIdx : session.seenMetaChunkIdx;
  let lastEnvSeq = isSource ? session.lastSourceEnvSeq : session.lastMetaEnvSeq;
  const setLastEnvSeq = (value: number | null): void => {
    if (isSource) {
      session.lastSourceEnvSeq = value;
    } else {
      session.lastMetaEnvSeq = value;
    }
    lastEnvSeq = value;
  };

  // Sender-restart detection: the client's envelope sequence counter is
  // initialised to 0 at process start, so an incoming envSeq of 0 with a
  // sufficiently-advanced previous seq is a strong signal that the peer
  // restarted. The threshold guards against first-packet replays.
  if (lastEnvSeq !== null && envSeq === 0 && lastEnvSeq >= META_RESTART_THRESHOLD) {
    app.debug(
      `[v2-server] ${channel} sender restart detected for ${session.key} ` +
        `(last seq was ${lastEnvSeq}); resetting ${channel} state`
    );
    setLastEnvSeq(null);
    seenChunkIdx.clear();
    if (!isSource) {
      session.metaRequested = false;
      session.statusRequested = false;
    }
  }

  if (lastEnvSeq !== null) {
    const distance = (envSeq - lastEnvSeq) >>> 0;
    if (distance !== 0 && distance >= 0x80000000) {
      metrics.duplicatePackets = (metrics.duplicatePackets || 0) + 1;
      app.debug(
        `[v2-server] stale ${channel} envelope seq=${envSeq} from ${session.key} (last=${lastEnvSeq}), dropping`
      );
      return true;
    }
    if (distance !== 0) {
      setLastEnvSeq(envSeq);
      seenChunkIdx.clear();
    } else if (seenChunkIdx.has(envIdx)) {
      metrics.duplicatePackets = (metrics.duplicatePackets || 0) + 1;
      app.debug(
        `[v2-server] duplicate ${channel} chunk seq=${envSeq} idx=${envIdx} from ${session.key}, dropping`
      );
      return true;
    }
  } else {
    setLastEnvSeq(envSeq);
    seenChunkIdx.clear();
  }

  // Bound the dedup Set: a well-behaved sender advances envSeq (which clears
  // the Set) far below this many chunks. Hitting the cap means the peer is
  // pinning the seq while streaming new idx values — drop further chunks for
  // this seq instead of growing memory without bound.
  if (seenChunkIdx.size >= MAX_ENVELOPE_CHUNK_INDICES) {
    metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
    app.debug(
      `[v2-server] ${channel} chunk-index cap (${MAX_ENVELOPE_CHUNK_INDICES}) reached for ` +
        `${session.key} at seq=${envSeq}; dropping until seq advances`
    );
    return true;
  }

  seenChunkIdx.add(envIdx);
  return false;
}

/**
 * Decrypt+decompress the META payload and parse the envelope object. Returns
 * null (after recording the relevant metric/error) when the payload is too
 * large, fails to decode, or is not a valid envelope object.
 */
async function decodeMetaEnvelope(
  ctx: ServerContext,
  parsed: ParsedPacket,
  secretKey: string
): Promise<MetaEnvelope | null> {
  const { app, metrics, recordError, stretchAsciiKey } = ctx;
  const decrypted = decryptBinary(parsed.payload, secretKey, { stretchAsciiKey });
  const decompressed = (await brotliDecompressAsync(decrypted, {
    maxOutputLength: MAX_DECOMPRESSED_SIZE
  })) as Buffer;

  // Count a successful decrypt+decompress as "meta received on the wire"
  // regardless of whether the envelope parses.
  metrics.bandwidth.metaBytesIn = (metrics.bandwidth.metaBytesIn || 0) + parsed.payload.length;
  metrics.bandwidth.metaPacketsIn = (metrics.bandwidth.metaPacketsIn || 0) + 1;

  if (decompressed.length > MAX_PARSE_PAYLOAD_SIZE) {
    metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
    app.error(
      `[v2] META payload too large to parse: ${decompressed.length} bytes (limit ${MAX_PARSE_PAYLOAD_SIZE})`
    );
    recordError(
      "general",
      `META payload too large: ${decompressed.length} bytes (limit ${MAX_PARSE_PAYLOAD_SIZE})`
    );
    return null;
  }

  let content: unknown;
  if (parsed.flags.messagepack) {
    try {
      content = msgpack.decode(decompressed);
    } catch {
      content = JSON.parse(decompressed.toString());
    }
  } else {
    content = JSON.parse(decompressed.toString());
  }

  if (!content || typeof content !== "object" || Array.isArray(content)) {
    metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
    app.debug("v2 META envelope was not an object, dropping");
    recordError("general", "v2 META envelope was not an object");
    return null;
  }
  return content as MetaEnvelope;
}

/**
 * Convert META entries into per-context Signal K deltas and dispatch them
 * through the normal `app.handleMessage` integration point.
 */
function dispatchMetaEntries(ctx: ServerContext, parsed: ParsedPacket, env: MetaEnvelope): void {
  const { app } = ctx;
  const entries = Array.isArray(env.entries) ? env.entries : [];
  const nowIso = new Date().toISOString();
  const byContext = new Map<string, Array<{ path: string; value: Record<string, unknown> }>>();
  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry.meta !== "object" || !rawEntry.meta) {
      continue;
    }
    // Require a present path before attempting pathDictionary decode;
    // decodeMetaEntry would otherwise coerce `undefined` into "undefined".
    if (rawEntry.path === null || rawEntry.path === undefined) {
      continue;
    }
    if (typeof rawEntry.path !== "string" && typeof rawEntry.path !== "number") {
      continue;
    }
    const entry = parsed.flags.pathDictionary
      ? decodeMetaEntry(rawEntry as { path: string | number; meta: Record<string, unknown> })
      : rawEntry;
    const path = typeof entry.path === "string" ? entry.path : String(entry.path ?? "");
    if (!path) {
      continue;
    }
    const context = typeof rawEntry.context === "string" ? rawEntry.context : "vessels.self";
    const bucket = byContext.get(context);
    const metaItem = { path, value: entry.meta as Record<string, unknown> };
    if (bucket) {
      bucket.push(metaItem);
    } else {
      byContext.set(context, [metaItem]);
    }
  }

  for (const [context, metaItems] of byContext) {
    const deltaMessage: Delta = {
      context,
      updates: [
        {
          timestamp: nowIso,
          values: [],
          meta: metaItems
        } as Delta["updates"][number]
      ]
    };
    app.handleMessage("", deltaMessage);
  }

  app.debug(
    `v2 meta received: kind=${env.kind ?? "?"}, entries=${entries.length}, contexts=${byContext.size}, envSeq=${env.seq ?? "?"}`
  );
}

/**
 * Decrypt and dispatch a METADATA (0x06) packet.
 */
export async function handleMetadataPacket(
  ctx: ServerContext,
  parsed: ParsedPacket,
  secretKey: string,
  session: ClientSession | null,
  rinfo?: { address: string; port: number }
): Promise<void> {
  const { app, metrics, recordError } = ctx;
  try {
    const env = await decodeMetaEnvelope(ctx, parsed, secretKey);
    if (!env) {
      return;
    }

    // Payload is now AES-GCM authenticated. If no session existed yet, allocate
    // one now — after auth — so envelope dedup/stale-drop state is tracked
    // without allowing an unauthenticated datagram to populate the session table.
    const activeSession = session ?? (rinfo ? getOrCreateSession(ctx, rinfo) : null);

    const hasSourceSnapshot =
      env.kind === "sources" &&
      env.sources !== null &&
      typeof env.sources === "object" &&
      !Array.isArray(env.sources);
    const entries = Array.isArray(env.entries) ? env.entries : [];
    if (!hasSourceSnapshot && entries.length === 0) {
      metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
      app.debug("v2 META envelope has no entries, dropping");
      recordError("general", "v2 META envelope has no entries");
      return;
    }

    const channel = hasSourceSnapshot ? "source snapshot" : "META";
    if (shouldDropEnvelopeBySeq(ctx, activeSession, env, channel)) {
      return;
    }

    if (hasSourceSnapshot) {
      const added = mergeSourceSnapshot(app, env.sources);
      app.debug(
        `v2 source snapshot received: sources=${Object.keys(env.sources || {}).length}, added=${added}, envSeq=${env.seq ?? "?"}`
      );
      return;
    }

    dispatchMetaEntries(ctx, parsed, env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof DecryptError) {
      const hint = err.keyMismatchHint
        ? " (possible stretchAsciiKey or key-format mismatch between peers)"
        : "";
      app.error(`v2 META decryption/authentication failed${hint}: ${msg}`);
      recordError("encryption", `v2 META decryption/authentication failed${hint}`);
    } else {
      metrics.malformedPackets = (metrics.malformedPackets || 0) + 1;
      app.error(`v2 handleMetadataPacket error: ${msg}`);
      recordError("general", `v2 META decode error: ${msg}`);
    }
  }
}
