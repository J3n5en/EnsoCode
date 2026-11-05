import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { runObserver } from "./agent.js";

describe("runObserver", () => {
	it("puts the current local time after prior memory so the memory stays a cacheable prefix", async () => {
		let userText = "";
		const loop = ((prompts: Array<{ content: Array<{ text?: string }> }>) => {
			userText = prompts[0]?.content?.[0]?.text ?? "";
			return {
				async *[Symbol.asyncIterator]() {},
				result: async () => [],
			};
		}) as unknown as Parameters<typeof runObserver>[0]["agentLoop"];

		await runObserver({
			model: { provider: "p", api: "a", id: "m" } as Model<any>,
			priorReflections: ["reflection-marker"],
			priorObservations: ["observation-marker"],
			chunk: "[Source entry id: e1]\n[User @ 2026-11-05 10:00]: hi",
			allowedSourceEntryIds: ["e1"],
			agentLoop: loop,
		});

		expect(userText.startsWith("CURRENT REFLECTIONS:")).toBe(true);
		const timeAt = userText.indexOf("Current local time:");
		expect(timeAt).toBeGreaterThan(userText.indexOf("observation-marker"));
		expect(timeAt).toBeLessThan(userText.indexOf("NEW CONVERSATION CHUNK:"));
	});
});
