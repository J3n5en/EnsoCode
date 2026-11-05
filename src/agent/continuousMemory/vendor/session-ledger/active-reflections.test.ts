import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../config.js";
import { reflectionsHardCapTokens, selectActiveReflections } from "./active-reflections.js";
import { foldLedger } from "./fold.js";
import { buildCompactionProjection, fullProjection } from "./projection.js";
import { recallMemorySources } from "./recall.js";
import { OM_OBSERVATIONS_RECORDED, OM_REFLECTIONS_RECORDED, type Entry, type Reflection } from "./types.js";

const memId = (n: number) => n.toString(16).padStart(12, "0");

function reflection(n: number, tokenCount = 50): Reflection {
	return { id: memId(n), content: `fact ${n}`, supportingObservationIds: [memId(1)], tokenCount };
}

function ledger(reflections: Reflection[]): Entry[] {
	return [
		{ type: "message", id: "m1" },
		{
			type: "custom",
			id: "o1",
			customType: OM_OBSERVATIONS_RECORDED,
			data: { coversUpToId: "m1", observations: [{ id: memId(1), content: "seen", timestamp: "2026-10-18 14:05", relevance: "high", sourceEntryIds: ["m1"], tokenCount: 5 }] },
		},
		{ type: "custom", id: "r1", customType: OM_REFLECTIONS_RECORDED, data: { coversUpToId: "m1", reflections } },
		{ type: "message", id: "keep" },
	];
}

const ids = (reflections: Reflection[]) => reflections.map((item) => item.id);
const tokens = (reflections: Reflection[]) => reflections.reduce((sum, item) => sum + item.tokenCount, 0);

describe("selectActiveReflections", () => {
	it("keeps every reflection in order when the total fits the budget", () => {
		const reflections = [reflection(0, 10), reflection(1, 10)];
		expect(ids(selectActiveReflections(reflections, 20))).toEqual([memId(0), memId(1)]);
	});

	it("keeps the oldest quarter and fills the rest from the newest", () => {
		const reflections = [0, 1, 2, 3, 4, 5].map((n) => reflection(n, 50));
		const active = selectActiveReflections(reflections, 200);
		expect(ids(active)).toEqual([memId(0), memId(3), memId(4), memId(5)]);
		expect(tokens(active)).toBeLessThanOrEqual(200);
	});

	it("gives unused head budget to newer reflections", () => {
		const reflections = [0, 1, 2, 3].map((n) => reflection(n, 100));
		expect(ids(selectActiveReflections(reflections, 250))).toEqual([memId(2), memId(3)]);
	});

	it("keeps the newest reflection when it alone exceeds the budget", () => {
		expect(ids(selectActiveReflections([reflection(0, 50), reflection(1, 50)], 10))).toEqual([memId(1)]);
	});
});

describe("hard reflection cap", () => {
	it("sits at twice the consolidation budget so it only acts when consolidation falls behind", () => {
		expect(reflectionsHardCapTokens(DEFAULTS.reflectionsPoolMaxTokens)).toBe(2 * DEFAULTS.reflectionsPoolMaxTokens);
	});

	it("bounds folded, observer and compaction reflections while trimmed ids stay recallable", () => {
		const reflections = [0, 1, 2, 3, 4, 5].map((n) => reflection(n, 50));
		const entries = ledger(reflections);
		const folded = foldLedger(entries, { reflectionsPoolMaxTokens: 100 });
		expect(folded.reflections).toHaveLength(6);
		expect(ids(folded.activeReflections)).toEqual([memId(0), memId(3), memId(4), memId(5)]);
		expect(ids(fullProjection(entries, undefined, 100).reflections)).toEqual([memId(0), memId(3), memId(4), memId(5)]);
		const projection = buildCompactionProjection(entries, "keep", { observationsPoolMaxTokens: 1, reflectionsPoolMaxTokens: 100 });
		expect(ids(projection.details.reflections)).toEqual([memId(0), memId(3), memId(4), memId(5)]);
		expect(recallMemorySources(entries, memId(1)).status).toBe("found");
	});

	it("applies the default budget when a caller passes none", () => {
		const reflections = Array.from({ length: 300 }, (_, n) => reflection(n, 100));
		const cap = reflectionsHardCapTokens(DEFAULTS.reflectionsPoolMaxTokens);
		expect(tokens(foldLedger(ledger(reflections)).activeReflections)).toBeLessThanOrEqual(cap);
		expect(tokens(fullProjection(ledger(reflections)).reflections)).toBeLessThanOrEqual(cap);
		expect(tokens(buildCompactionProjection(ledger(reflections), "keep", { observationsPoolMaxTokens: 1 }).reflections)).toBeLessThanOrEqual(cap);
	});
});
