import { createHash } from "node:crypto";

/** Wire IDs Qoder accepts: `^[a-zA-Z0-9_-]{1,64}$`. */
const VALID_WIRE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Namespace reserved for generated IDs. An input that already looks like a
 * generated value is re-hashed, so a pass-through ID can never coincide with
 * a generated one.
 */
const RESERVED_WIRE_ID = /^qtc_[0-9a-f]{60}$/;

function digestToolCallId(original: string): string {
  // Hash the complete internal ID, not just the part before '|':
  // `call_A|fc_A` and `call_A|fc_B` must not collapse onto the same wire ID.
  // The fixed prefix domain-separates these digests from any other SHA-256
  // usage and versions the scheme (`v1`).
  return `qtc_${createHash("sha256").update("qoder-tool-call-id:v1\0").update(original).digest("hex").slice(0, 60)}`;
}

export type QoderToolCallIdMapper = (original: string) => string;

/**
 * Qoder rejects tool call IDs outside `^[a-zA-Z0-9_-]+$` (and overlong ones)
 * with `400 tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'`.
 * pi's OpenAI Responses adapter builds internal IDs like `call_id|item_id`,
 * which contain `|`; replaying them verbatim makes the upstream reject every
 * later request in the session.
 *
 * The mapper rewrites IDs for the wire only, deterministically: the assistant
 * `tool_calls` entry and its `tool` result map through the same function, so
 * they stay paired, and session history is never mutated. Create one mapper
 * per request transform — consistent within the request, stable across
 * requests (the digest is deterministic), with no cross-request state.
 *
 * `digest` exists so tests can force collisions; production uses the default.
 */
export function createQoderToolCallIdMapper(
  digest: (original: string) => string = digestToolCallId,
): QoderToolCallIdMapper {
  const byOriginal = new Map<string, string>();
  const byWire = new Map<string, string>();

  return (original: string): string => {
    if (typeof original !== "string" || original.length === 0) {
      throw new Error("Qoder tool call ID must be a non-empty string");
    }
    const cached = byOriginal.get(original);
    if (cached !== undefined) return cached;

    const wireId = VALID_WIRE_ID.test(original) && !RESERVED_WIRE_ID.test(original) ? original : digest(original);

    const owner = byWire.get(wireId);
    if (owner !== undefined && owner !== original) {
      // Never repair a collision by remapping an earlier ID or by leaking the
      // raw internal ID onto the wire; fail the request instead.
      throw new Error("Qoder tool call ID mapping collision");
    }
    byOriginal.set(original, wireId);
    byWire.set(wireId, original);
    return wireId;
  };
}
