import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { hashId } from "../../ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { truncateRecordContent } from "../../serialize.js";
import { estimateStringTokens } from "../../tokens.js";
import { reflectionToSummaryLine, type Reflection } from "../../session-ledger/index.js";
import { logAgentStreamError } from "../stream-errors.js";
import { resolveWorkerStreamSimple, type StreamableModelRegistry, type WorkerStreamSimple } from "../worker-stream.js";
import { REFLECTION_CONSOLIDATOR_SYSTEM } from "./prompts.js";

interface RunReflectionConsolidatorArgs {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	reflections: Reflection[];
	targetTokens: number;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	maxOutputTokens?: number;
	thinkingLevel?: ModelThinkingLevel;
	modelRegistry?: StreamableModelRegistry;
	streamSimple?: WorkerStreamSimple;
}

export type ReflectionConsolidation = {
	reflections: Reflection[];
	supersededReflectionIds: string[];
};

const ConsolidateReflectionsSchema = Type.Object({
	reflections: Type.Array(
		Type.Object({
			content: Type.String({ minLength: 1 }),
			replacesReflectionIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		}),
		{ minItems: 1 },
	),
});

type ConsolidateReflectionsArgs = Static<typeof ConsolidateReflectionsSchema>;

function tokenSum(reflections: readonly Reflection[]): number {
	return reflections.reduce((sum, reflection) => sum + reflection.tokenCount, 0);
}

/** Rewrite a batch of reflections into a smaller set; undefined unless the result is strictly smaller. */
export async function runReflectionConsolidator(args: RunReflectionConsolidatorArgs): Promise<ReflectionConsolidation | undefined> {
	const { model, apiKey, headers, env, reflections, targetTokens, signal } = args;
	if (reflections.length < 2) return undefined;

	const byId = new Map(reflections.map((reflection) => [reflection.id, reflection]));
	const proposals = new Map<string, { content: string; replaces: Set<string> }>();
	let rejected = 0;

	const consolidateReflections: AgentTool<typeof ConsolidateReflectionsSchema> = {
		name: "consolidate_reflections",
		label: "Consolidate reflections",
		description: "Replace current reflections with fewer, denser reflections that carry their full durable meaning.",
		parameters: ConsolidateReflectionsSchema,
		execute: async (_id, params: ConsolidateReflectionsArgs) => {
			let accepted = 0;
			for (const proposal of params.reflections) {
				const content = truncateRecordContent(proposal.content.trim());
				const replaces = Array.from(new Set(proposal.replacesReflectionIds));
				if (!content || /\r|\n/.test(content) || replaces.length === 0 || !replaces.every((id) => byId.has(id))) {
					rejected++;
					continue;
				}
				const id = hashId(content);
				const existing = proposals.get(id) ?? { content, replaces: new Set<string>() };
				for (const replaced of replaces) existing.replaces.add(replaced);
				proposals.set(id, existing);
				accepted++;
			}
			return {
				content: [{ type: "text", text: `Accepted ${accepted} consolidated reflection${accepted === 1 ? "" : "s"}; ${rejected} rejected so far.` }],
				details: { accepted, rejected },
			};
		},
	};

	const userText = `CURRENT REFLECTIONS (~${tokenSum(reflections).toLocaleString()} tokens):\n${reflections.map(reflectionToSummaryLine).join("\n")}\n\nTarget for these reflections after consolidation: ~${targetTokens.toLocaleString()} tokens.\nConsolidate them by calling consolidate_reflections. If nothing can be consolidated safely, do not call the tool.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = {
		messages: [{ role: "system", content: REFLECTION_CONSOLIDATOR_SYSTEM, timestamp: Date.now() }],
		tools: [consolidateReflections as AgentTool<any>],
	};
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		env,
		maxTokens: boundedMaxTokens(model, args.maxOutputTokens ?? AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined
			? {
				finishTurn: (turn: { message: { stopReason?: string } }) => {
					if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return;
					turnCount += 1;
					return turnCount >= effectiveMaxTurns ? { action: "end" as const } : undefined;
				},
			}
			: {}),
	};

	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, signal, resolveWorkerStreamSimple(model, args.modelRegistry, args.streamSimple));
	for await (const event of stream) logAgentStreamError("reflector", event);
	await stream.result();

	const replaced = new Set<string>();
	const created: Reflection[] = [];
	for (const [id, proposal] of proposals) {
		for (const replacedId of proposal.replaces) replaced.add(replacedId);
		if (byId.has(id)) continue;
		const supportingObservationIds = Array.from(new Set(
			Array.from(proposal.replaces).flatMap((replacedId) => byId.get(replacedId)?.supportingObservationIds ?? []),
		));
		created.push({ id, content: proposal.content, supportingObservationIds, tokenCount: estimateStringTokens(proposal.content) });
	}
	const supersededReflectionIds = reflections.map((reflection) => reflection.id).filter((id) => replaced.has(id) && !proposals.has(id));
	const supersededTokens = tokenSum(supersededReflectionIds.map((id) => byId.get(id)!));
	const createdTokens = tokenSum(created);
	const accepted = supersededReflectionIds.length > 0 && createdTokens < supersededTokens;
	debugLog("reflection_consolidator.result", {
		inputCount: reflections.length,
		inputTokens: tokenSum(reflections),
		targetTokens,
		createdCount: created.length,
		createdTokens,
		supersededCount: supersededReflectionIds.length,
		supersededTokens,
		rejected,
		accepted,
	});
	return accepted ? { reflections: created, supersededReflectionIds } : undefined;
}
