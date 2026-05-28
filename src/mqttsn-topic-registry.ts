"use strict";

/**
 * MQTT-SN topic registry — bidirectional map between topic name strings and
 * 2-byte numeric topic IDs.
 *
 * Used by both the client (tracks gateway-assigned IDs from REGACK) and the
 * gateway (assigns IDs on receipt of REGISTER and stores the mapping).
 *
 * Topic IDs 0x0000 and 0xFFFF are reserved by the MQTT-SN spec; valid IDs
 * are 0x0001–0xFFFE.
 */
export class TopicRegistry {
  private nameToId = new Map<string, number>();
  private idToName = new Map<number, string>();
  private nextId = 1; // gateway-side auto-assign counter

  /**
   * Assign a new topic ID for a name (gateway role).
   * If the name is already registered, returns the existing ID.
   */
  assign(topicName: string): number {
    const existing = this.nameToId.get(topicName);
    if (existing !== undefined) return existing;
    // Skip IDs already occupied by other topics (matters after wrap-around)
    const start = this.nextId;
    while (this.idToName.has(this.nextId)) {
      this.nextId = this.nextId >= 0xfffe ? 1 : this.nextId + 1;
      if (this.nextId === start) throw new Error("MQTT-SN topic ID space exhausted");
    }
    const id = this.nextId;
    this.nextId = this.nextId >= 0xfffe ? 1 : this.nextId + 1;
    this.nameToId.set(topicName, id);
    this.idToName.set(id, topicName);
    return id;
  }

  /**
   * Store a gateway-assigned mapping (client role, called on REGACK).
   */
  set(topicName: string, topicId: number): void {
    const prevId = this.nameToId.get(topicName);
    if (prevId !== undefined && prevId !== topicId) this.idToName.delete(prevId);
    const prevName = this.idToName.get(topicId);
    if (prevName !== undefined && prevName !== topicName) this.nameToId.delete(prevName);
    this.nameToId.set(topicName, topicId);
    this.idToName.set(topicId, topicName);
  }

  getIdForName(topicName: string): number | undefined {
    return this.nameToId.get(topicName);
  }

  getNameForId(topicId: number): string | undefined {
    return this.idToName.get(topicId);
  }

  clear(): void {
    this.nameToId.clear();
    this.idToName.clear();
    this.nextId = 1;
  }
}

// ── Topic name ↔ Signal K path conversion ─────────────────────────────────────

/**
 * Convert a Signal K path to an MQTT-SN topic name.
 *
 * Example: path "navigation.speedOverGround", prefix "sk"
 *       →  topic "sk/navigation/speedOverGround"
 *
 * Throws if the path contains MQTT wildcard or separator characters (/, #, +)
 * which would corrupt the topic hierarchy.
 */
export function skPathToTopic(path: string, prefix: string): string {
  if (/[/#+]/.test(path)) {
    throw new Error(`Signal K path contains invalid MQTT characters: "${path}"`);
  }
  return `${prefix}/${path.replace(/\./g, "/")}`;
}

/**
 * Convert an MQTT-SN topic name back to a Signal K path.
 *
 * Example: topic "sk/navigation/speedOverGround", prefix "sk"
 *       →  path "navigation.speedOverGround"
 *
 * Returns null if the topic does not start with the expected prefix.
 */
export function topicToSkPath(topic: string, prefix: string): string | null {
  const expectedStart = `${prefix}/`;
  if (!topic.startsWith(expectedStart)) return null;
  return topic.slice(expectedStart.length).replace(/\//g, ".");
}
