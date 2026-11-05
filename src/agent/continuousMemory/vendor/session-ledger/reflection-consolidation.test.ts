import { describe, expect, it } from "vitest";
import { foldLedger } from "./fold.js";
import { buildCompactionProjection, fullProjection } from "./projection.js";
import { recallMemorySources } from "./recall.js";
import {
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_CONSOLIDATED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
	type Observation,
	type Reflection,
} from "./types.js";

const id = (n: number) => n.toString(16).padStart(12, "0");

function obs(n: number, sourceEntryId: string): Observation {
	return { id: id(n), content: `obs ${n}`, timestamp: "2026-10-18 10:00", relevance: "high", sourceEntryIds: [sourceEntryId], tokenCount: 10 };
}

function refl(n: number, support: number[]): Reflection {
	return { id: id(n), content: `reflection ${n}`, supportingObservationIds: support.map(id), tokenCount: 100 };
}

function ledger(): Entry[] {
	return [
		{ type: "message", id: "m1" },
		{ type: "custom", id: "c1", customType: OM_OBSERVATIONS_RECORDED, data: { coversUpToId: "m1", observations: [obs(1, "m1"), obs(2, "m1")] } },
		{ type: "custom", id: "c2", customType: OM_REFLECTIONS_RECORDED, data: { coversUpToId: "m1", reflections: [refl(0xa1, [1]), refl(0xa2, [2]), refl(0xa3, [2])] } },
		{
			type: "custom",
			id: "c3",
			customType: OM_REFLECTIONS_CONSOLIDATED,
			data: { coversUpToId: "m1", supersededReflectionIds: [id(0xa1), id(0xa2)], reflections: [refl(0xb1, [1, 2])] },
		},
		{ type: "message", id: "keep" },
	];
}

describe("reflection consolidation ledger", () => {
	it("removes superseded reflections from the active set but keeps them addressable", () => {
		const folded = foldLedger(ledger());
		expect(folded.activeReflections.map((r) => r.id)).toEqual([id(0xa3), id(0xb1)]);
		expect(folded.reflectionsById.has(id(0xa1))).toBe(true);
		expect(folded.supersededReflectionIds.has(id(0xa2))).toBe(true);
	});

	it("projects only active reflections into observer input and compaction summaries", () => {
		expect(fullProjection(ledger()).reflections.map((r) => r.id)).toEqual([id(0xa3), id(0xb1)]);
		const projection = buildCompactionProjection(ledger(), "keep", { observationsPoolMaxTokens: 1 });
		expect(projection.fullFold).toBe(true);
		expect(projection.reflections.map((r) => r.id)).toEqual([id(0xa3), id(0xb1)]);
	});

	it("does not apply a consolidation past the fold boundary", () => {
		const entries = ledger();
		expect(foldLedger(entries, { upToEntryId: "c2" }).activeReflections).toHaveLength(3);
	});

	it("recalls both superseded and consolidated reflections by id", () => {
		const superseded = recallMemorySources(ledger(), id(0xa1));
		expect(superseded.status).toBe("found");
		expect(superseded.observations.map((o) => o.observation.id)).toEqual([id(1)]);
		const merged = recallMemorySources(ledger(), id(0xb1));
		expect(merged.status).toBe("found");
		expect(merged.kind).toBe("reflection");
		expect(merged.observations.map((o) => o.observation.id)).toEqual([id(1), id(2)]);
	});

	it("ignores malformed consolidation entries", () => {
		const entries = ledger();
		const bad: Entry[] = [
			{ type: "custom", id: "x1", customType: OM_REFLECTIONS_CONSOLIDATED, data: { coversUpToId: "m1", supersededReflectionIds: [], reflections: [] } },
			{ type: "custom", id: "x2", customType: OM_REFLECTIONS_CONSOLIDATED, data: { coversUpToId: "m1", supersededReflectionIds: ["not-an-id"], reflections: [] } },
			{ type: "custom", id: "x3", customType: OM_REFLECTIONS_CONSOLIDATED, data: { supersededReflectionIds: [id(0xa3)], reflections: [] } },
			{ type: "custom", id: "x4", customType: OM_REFLECTIONS_CONSOLIDATED, data: { coversUpToId: "m1", supersededReflectionIds: [id(0xa3)], reflections: [{ id: "bad" }] } },
			{ type: "custom", id: "x5", customType: OM_REFLECTIONS_CONSOLIDATED, data: null },
		];
		entries.splice(4, 0, ...bad);
		expect(foldLedger(entries).activeReflections.map((r) => r.id)).toEqual([id(0xa3), id(0xb1)]);
		expect(fullProjection(entries).reflections.map((r) => r.id)).toEqual([id(0xa3), id(0xb1)]);
		expect(recallMemorySources(entries, id(0xa3)).status).toBe("found");
	});
});
