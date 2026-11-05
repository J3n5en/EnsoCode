import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../config.js";
import { Runtime } from "../runtime.js";
import {
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_CONSOLIDATED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
	type Observation,
	type Reflection,
} from "../session-ledger/index.js";

const mocks = vi.hoisted(() => ({ runReflector: vi.fn(), runReflectionConsolidator: vi.fn() }));
vi.mock("../agents/reflector/agent.js", () => ({ runReflector: mocks.runReflector }));
vi.mock("../agents/reflector/consolidate.js", () => ({ runReflectionConsolidator: mocks.runReflectionConsolidator }));

const { registerConsolidationTrigger, runConsolidationPipeline } = await import("./consolidation-trigger.js");

const id = (n: number) => n.toString(16).padStart(12, "0");

function obs(n: number, sourceEntryId: string): Observation {
	return { id: id(n), content: `obs ${n}`, timestamp: "2026-10-18 10:00", relevance: "high", sourceEntryIds: [sourceEntryId], tokenCount: 10 };
}

function refl(n: number, tokenCount = 100): Reflection {
	return { id: id(n), content: `reflection ${n}`, supportingObservationIds: [id(1)], tokenCount };
}

function message(entryId: string): Entry {
	return { type: "message", id: entryId, message: { role: "user", content: [{ type: "text", text: "x".repeat(400) }] } };
}

function harness(entries: Entry[], config: Partial<typeof DEFAULTS> = {}) {
	const runtime = new Runtime();
	runtime.configLoaded = true;
	runtime.config = { ...DEFAULTS, observeAfterTokens: 1_000_000, reflectAfterTokens: 1, ...config };
	runtime.resolveModel = async () => ({ ok: true, model: {} });
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	let seq = 0;
	const pi = {
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", id: `new-${seq++}`, customType, data }),
		on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler),
	};
	const ctx = { cwd: "/tmp", hasUI: false, model: {}, modelRegistry: {}, sessionManager: { getBranch: () => entries } };
	return { runtime, pi: pi as never, ctx, handlers };
}

function reflectedLedger(): Entry[] {
	return [
		message("m1"),
		{ type: "custom", id: "o1", customType: OM_OBSERVATIONS_RECORDED, data: { coversUpToId: "m1", observations: [obs(1, "m1")] } },
		{ type: "custom", id: "r1", customType: OM_REFLECTIONS_RECORDED, data: { coversUpToId: "m1", reflections: [refl(0xa1)] } },
		message("m2"),
	];
}

beforeEach(() => {
	mocks.runReflector.mockReset().mockResolvedValue(undefined);
	mocks.runReflectionConsolidator.mockReset().mockResolvedValue(undefined);
});

describe("reflector stage", () => {
	it("does not run when no observation landed after the latest reflection", async () => {
		const { runtime, pi, ctx } = harness(reflectedLedger());
		await runConsolidationPipeline(pi, runtime, ctx);
		expect(mocks.runReflector).not.toHaveBeenCalled();
	});

	it("does not launch consolidation when only the reflector clock is due without new observations", () => {
		const { runtime, pi, ctx, handlers } = harness(reflectedLedger());
		const launch = vi.spyOn(runtime, "launchConsolidationTask");
		registerConsolidationTrigger(pi, runtime);
		handlers.get("turn_end")?.({}, ctx);
		expect(launch).not.toHaveBeenCalled();
	});

	it("runs once observation coverage moves past the latest reflection", async () => {
		const entries = reflectedLedger();
		entries.push({ type: "custom", id: "o2", customType: OM_OBSERVATIONS_RECORDED, data: { coversUpToId: "m2", observations: [obs(2, "m2")] } });
		const { runtime, pi, ctx } = harness(entries);
		await runConsolidationPipeline(pi, runtime, ctx);
		expect(mocks.runReflector).toHaveBeenCalledTimes(1);
	});

	it("consolidates over-budget reflections before reflecting and feeds the reflector only active ones", async () => {
		const entries = reflectedLedger();
		const recorded = entries[2] as { data: { reflections: Reflection[] } };
		recorded.data.reflections = [refl(0xa1), refl(0xa2), refl(0xa3), refl(0xa4)];
		entries.push({ type: "custom", id: "o2", customType: OM_OBSERVATIONS_RECORDED, data: { coversUpToId: "m2", observations: [obs(2, "m2")] } });
		const merged = { ...refl(0xb1, 50), supportingObservationIds: [id(1)] };
		mocks.runReflectionConsolidator.mockResolvedValue({ reflections: [merged], supersededReflectionIds: [id(0xa1), id(0xa2)] });
		const { runtime, pi, ctx } = harness(entries, { reflectionsPoolMaxTokens: 300 });

		await runConsolidationPipeline(pi, runtime, ctx);

		const batch = mocks.runReflectionConsolidator.mock.calls[0]?.[0] as { reflections: Reflection[]; targetTokens: number };
		expect(batch.reflections.map((r) => r.id)).toEqual([id(0xa1), id(0xa2), id(0xa3)]);
		expect(batch.targetTokens).toBe(150);
		const appended = entries.find((entry) => entry.customType === OM_REFLECTIONS_CONSOLIDATED);
		expect(appended?.data).toEqual({ reflections: [merged], supersededReflectionIds: [id(0xa1), id(0xa2)], coversUpToId: "m2" });
		const reflectorInput = mocks.runReflector.mock.calls[0]?.[0] as { reflections: Reflection[] };
		expect(reflectorInput.reflections.map((r) => r.id)).toEqual([id(0xa3), id(0xa4), id(0xb1)]);
	});

	it("skips consolidation while active reflections fit the budget", async () => {
		const entries = reflectedLedger();
		entries.push({ type: "custom", id: "o2", customType: OM_OBSERVATIONS_RECORDED, data: { coversUpToId: "m2", observations: [obs(2, "m2")] } });
		const { runtime, pi, ctx } = harness(entries, { reflectionsPoolMaxTokens: 300 });
		await runConsolidationPipeline(pi, runtime, ctx);
		expect(mocks.runReflectionConsolidator).not.toHaveBeenCalled();
		expect(mocks.runReflector).toHaveBeenCalledTimes(1);
	});

	it("consolidates from the oldest unsuperseded reflection and bounds reflector input when consolidation declines", async () => {
		const entries = reflectedLedger();
		const recorded = entries[2] as { data: { reflections: Reflection[] } };
		recorded.data.reflections = [0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6].map((n) => refl(n));
		entries.push({ type: "custom", id: "o2", customType: OM_OBSERVATIONS_RECORDED, data: { coversUpToId: "m2", observations: [obs(2, "m2")] } });
		const { runtime, pi, ctx } = harness(entries, { reflectionsPoolMaxTokens: 100 });

		await runConsolidationPipeline(pi, runtime, ctx);

		const batch = mocks.runReflectionConsolidator.mock.calls[0]?.[0] as { reflections: Reflection[] };
		expect(batch.reflections.map((r) => r.id)).toEqual([id(0xa1), id(0xa2)]);
		const reflectorInput = mocks.runReflector.mock.calls[0]?.[0] as { reflections: Reflection[] };
		expect(reflectorInput.reflections.map((r) => r.id)).toEqual([id(0xa5), id(0xa6)]);
	});
});
