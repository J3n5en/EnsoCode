/**
 * Runtime guard for the repo-owned OMP overlay.
 *
 * Loaded only from this directory (plus host packages). Do not import
 * Electron `src/` from here — OMP/Bun resolves `.omp/extensions/*`.
 */

export const TRELLIS_WORKFLOW_STATE_TYPE = "trellis-workflow-state";

export const TRELLIS_SUBAGENT_TYPES = [
   "trellis-implement",
   "trellis-check",
   "trellis-research",
] as const;

const TRELLIS_SUBAGENTS = new Set<string>(TRELLIS_SUBAGENT_TYPES);
export const RUNNER_GUARD_INSTALLED = Symbol.for("enso.trellisSubagentConsentGate");

export type WorkflowStateMessage = {
   customType?: string;
   role?: string;
   content?: unknown;
};

export type BeforeAgentStartResult = {
   messages?: WorkflowStateMessage[];
   systemPrompt?: string;
};

export type ExtensionRunnerLike = {
   prototype: object;
};

export type HostPackageExports = {
   ExtensionRunner?: ExtensionRunnerLike;
};

export function isTrellisSubAgent(env: NodeJS.ProcessEnv = process.env): boolean {
   const blocked = env.PI_BLOCKED_AGENT;
   return typeof blocked === "string" && TRELLIS_SUBAGENTS.has(blocked);
}

export function isWorkflowStateMessage(message: unknown): boolean {
   if (message === null || typeof message !== "object") return false;
   return (message as WorkflowStateMessage).customType === TRELLIS_WORKFLOW_STATE_TYPE;
}

export function stripWorkflowStateMessages<T>(messages: T[]): T[] {
   return messages.filter((message) => !isWorkflowStateMessage(message));
}

export function filterBeforeAgentStartResult(
   result: unknown,
   subAgent = isTrellisSubAgent(),
): unknown {
   if (!subAgent || result === null || typeof result !== "object") return result;
   const record = result as BeforeAgentStartResult;
   if (!Array.isArray(record.messages)) return result;
   const messages = stripWorkflowStateMessages(record.messages);
   return {
      ...record,
      messages: messages.length > 0 ? messages : undefined,
   };
}

export function filterContextResult(result: unknown, subAgent = isTrellisSubAgent()): unknown {
   if (!subAgent || !Array.isArray(result)) return result;
   return stripWorkflowStateMessages(result);
}

export function installExtensionRunnerGuard(Runner: ExtensionRunnerLike): void {
   const proto = Runner.prototype as Record<PropertyKey, unknown>;
   if (proto[RUNNER_GUARD_INSTALLED]) return;
   proto[RUNNER_GUARD_INSTALLED] = true;

   const origBefore = proto.emitBeforeAgentStart;
   if (typeof origBefore === "function") {
      proto.emitBeforeAgentStart = async function (...args: unknown[]) {
         const result = await (origBefore as (...next: unknown[]) => unknown).apply(this, args);
         return filterBeforeAgentStartResult(result, isTrellisSubAgent());
      };
   }

   const origContext = proto.emitContext;
   if (typeof origContext === "function") {
      proto.emitContext = async function (...args: unknown[]) {
         const result = await (origContext as (...next: unknown[]) => unknown).apply(this, args);
         return filterContextResult(result, isTrellisSubAgent());
      };
   }
}

export function installHostExtensionRunnerGuard(hostExports: HostPackageExports | undefined): void {
   const Runner = hostExports?.ExtensionRunner;
   if (!Runner) {
      throw new Error("enso-subagent-guard: host pi exports do not expose ExtensionRunner");
   }
   installExtensionRunnerGuard(Runner);
}
