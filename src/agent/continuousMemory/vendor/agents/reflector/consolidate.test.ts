import { describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { hashId } from "../../ids.js";
import type { Reflection } from "../../session-ledger/index.js";
import { runReflectionConsolidator } from "./consolidate.js";

function refl(content: string, support: string[]): Reflection {
	return { id: hashId(content), content, supportingObservationIds: support, tokenCount: 100 };
}

const a = refl("User prefers pnpm over npm for this repo.", ["000000000001"]);
const b = refl("User wants pnpm used for every install.", ["000000000002", "000000000001"]);
const c = refl("Project targets Electron with a TypeScript main process.", ["000000000003"]);

type Proposal = { content: string; replacesReflectionIds: string[] };

function loopCalling(...calls: Proposal[][]) {
	let userText = "";
	const loop = ((prompts: Array<{ content: Array<{ text?: string }> }>, context: { tools: Array<{ execute: (id: string, params: unknown) => Promise<unknown> }> }) => {
		userText = prompts[0]?.content?.[0]?.text ?? "";
		return {
			async *[Symbol.asyncIterator]() {
				for (const reflections of calls) await context.tools[0].execute("call", { reflections });
			},
			result: async () => [],
		};
	}) as unknown as Parameters<typeof runReflectionConsolidator>[0]["agentLoop"];
	return { loop, userText: () => userText };
}

const model = { provider: "p", api: "a", id: "m" } as Model<any>;

describe("runReflectionConsolidator", () => {
	it("merges reflections and unions their supporting observations", async () => {
		const { loop, userText } = loopCalling([
			{ content: "User requires pnpm for all installs in this repo.", replacesReflectionIds: [a.id, b.id] },
			{ content: "Unknown target is rejected.", replacesReflectionIds: ["ffffffffffff"] },
		]);
		const result = await runReflectionConsolidator({ model, reflections: [a, b, c], targetTokens: 150, agentLoop: loop });
		expect(userText()).toContain(`[${c.id}] ${c.content}`);
		expect(userText()).toContain("150");
		expect(result?.supersededReflectionIds).toEqual([a.id, b.id]);
		expect(result?.reflections).toHaveLength(1);
		expect(result?.reflections[0]).toMatchObject({
			id: hashId("User requires pnpm for all installs in this repo."),
			supportingObservationIds: ["000000000001", "000000000002"],
		});
	});

	it("keeps an existing reflection active when the model reuses its exact wording", async () => {
		const { loop } = loopCalling([{ content: a.content, replacesReflectionIds: [a.id, b.id] }]);
		const result = await runReflectionConsolidator({ model, reflections: [a, b, c], targetTokens: 150, agentLoop: loop });
		expect(result).toEqual({ reflections: [], supersededReflectionIds: [b.id] });
	});

	it("returns nothing when the rewrite would not shrink the replaced reflections", async () => {
		const { loop } = loopCalling([{ content: "x".repeat(2_000), replacesReflectionIds: [a.id] }]);
		expect(await runReflectionConsolidator({ model, reflections: [a, b, c], targetTokens: 150, agentLoop: loop })).toBeUndefined();
	});

	it("returns nothing when the model does not call the tool", async () => {
		const { loop } = loopCalling();
		expect(await runReflectionConsolidator({ model, reflections: [a, b, c], targetTokens: 150, agentLoop: loop })).toBeUndefined();
	});
});
