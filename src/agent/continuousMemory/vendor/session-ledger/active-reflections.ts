import { DEFAULTS } from "../config.js";
import type { Reflection } from "./types.js";

/** Share of the cap reserved for the oldest reflections; unused head budget goes to the newest. */
const HEAD_RATIO = 0.25;

/**
 * Deterministic fallback ceiling on reflections sent to memory agents and compaction
 * summaries. Consolidation keeps them under `reflectionsPoolMaxTokens`; the cap sits
 * at twice that so it only trims when consolidation is failing or falling behind.
 */
export function reflectionsHardCapTokens(reflectionsPoolMaxTokens: number | undefined): number {
	const budget = typeof reflectionsPoolMaxTokens === "number" && Number.isFinite(reflectionsPoolMaxTokens) && reflectionsPoolMaxTokens > 0
		? reflectionsPoolMaxTokens
		: DEFAULTS.reflectionsPoolMaxTokens;
	return Math.floor(budget * 2);
}

/**
 * Ledger-ordered subset within `maxTokens`: the oldest reflections fitting a quarter of it
 * (foundational facts the reflector will not restate), then the newest filling the rest.
 * Trimmed records stay in the ledger and recallable by id.
 */
export function selectActiveReflections(reflections: readonly Reflection[], maxTokens: number): Reflection[] {
	let total = 0;
	for (const reflection of reflections) total += reflection.tokenCount;
	if (total <= maxTokens) return [...reflections];

	let headTokens = 0;
	let headEnd = 0;
	while (headEnd < reflections.length && headTokens + reflections[headEnd].tokenCount <= maxTokens * HEAD_RATIO) {
		headTokens += reflections[headEnd++].tokenCount;
	}
	let tailTokens = headTokens;
	let tailStart = reflections.length;
	while (tailStart > headEnd && tailTokens + reflections[tailStart - 1].tokenCount <= maxTokens) {
		tailTokens += reflections[--tailStart].tokenCount;
	}
	const active = [...reflections.slice(0, headEnd), ...reflections.slice(tailStart)];
	return active.length > 0 ? active : reflections.slice(-1);
}
