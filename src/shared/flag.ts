/**
 * Interpret a boolean-ish configuration or environment value as a tri-state.
 *
 * The plugin schema produces a real boolean, but the same flags are also set by
 * hand in JSON config files and by shell exports, where `"true"`/`"1"`/`"yes"`/
 * `"on"` (and their negatives) are all natural spellings. Accepting only
 * `true`/`"true"`/`"1"` made every other spelling read as "off".
 *
 * `"invalid"` is returned rather than folded into `false`, because for a
 * fail-closed security flag those two mean very different things: absent means
 * "the operator never set this, keep the compatibility default", whereas an
 * unparseable explicit value means "the operator intended something and we
 * cannot tell what" — which must not silently grant access.
 */
export type FlagState = "absent" | "true" | "false" | "invalid";

const TRUTHY_FLAGS = new Set(["true", "1", "yes", "on"]);
const FALSY_FLAGS = new Set(["false", "0", "no", "off"]);

export function parseFlag(value: unknown): FlagState {
  if (value === undefined || value === null || value === "") return "absent";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "") return "absent";
    if (TRUTHY_FLAGS.has(normalized)) return "true";
    if (FALSY_FLAGS.has(normalized)) return "false";
  }
  return "invalid";
}
