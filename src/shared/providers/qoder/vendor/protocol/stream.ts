import crypto from "node:crypto";
import * as PiAi from "@earendil-works/pi-ai";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  clampThinkingLevel,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { resolveQoderIdentity } from "../auth/oauth.js";
import { discoverChatEndpoints } from "../../chatEndpoints.js";
import { getCachedModelConfig, MAX_OUTPUT_TOKENS } from "../catalog.js";
import { buildAuthHeaders, getMachineId } from "../cosy.js";
import { applyQoderCredits } from "../credits.js";
import { getQoderBaseUrl, getQoderRegionConfig } from "../region.js";
import { qoderEncodeBody } from "./encoding.js";
import { isDegenerateDsmlTurn, stripDsmlResidue, stripThinkingTags, ThinkingTagParser } from "./thinking.js";
import { transformMessagesForQoder, transformTools } from "./transform.js";

/**
 * Qoder's scheduler reports a busy model as error code 10605. The official
 * client treats `isQueued:false` + `serviceAvailable:true` as "ready" and
 * re-sends the request after `retryAfterSeconds`; without that recovery one
 * transient rejection kills the whole turn. We mirror the bounded part of it.
 *
 * A real queue (`isQueued:true`) is NOT retried in-line: the wait can be
 * minutes, and sleeping inside the stream would block the turn under the
 * host's abort and retry policy. Instead the queued rejection is surfaced
 * as a host-schedulable error carrying the queue fields and a
 * `retry-after-ms=` hint, with no bare `403` in the text (a bare 403 is
 * classified as an auth failure by the host and never retried).
 */
const MODEL_BUSY_CODE = "10605";
const DEFAULT_MODEL_BUSY_RETRIES = 2;
const MAX_MODEL_BUSY_RETRIES = 10;
const MODEL_BUSY_MAX_WAIT_MS = 5_000;

/**
 * Qoder tracks the daily chat allowance per node, so an account can exhaust it
 * on one node while another node still serves the same account (this is what
 * the official CLI avoids by routing agent chat to its remote-agent node).
 * Code 110 is that rejection; it is recoverable only by switching nodes, never
 * by re-sending to the same one.
 */
const DAILY_CHAT_LIMIT_CODE = "110";

/** A "daily chat limit" rejection from one Qoder chat node. */
export class QoderDailyChatLimitError extends Error {
  constructor(
    message: string,
    readonly sawModelOutput = false,
  ) {
    super(message);
    this.name = "QoderDailyChatLimitError";
  }
}

/** A recovery-eligible "model busy" rejection from Qoder's queue scheduler. */
class QoderModelBusyError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | undefined,
    readonly sawModelOutput = false,
  ) {
    super(message);
    this.name = "QoderModelBusyError";
  }
}

type ModelBusyQueueSnapshot =
  | { kind: "ready"; retryAfterMs?: number }
  | {
      kind: "queued";
      waitMs: number;
      queueCount?: number;
      queueType?: string;
    };

/** Parse `unknown | JSON string` layers until an object is found (bounded). */
function parseJsonObject(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") {
    try {
      return parseJsonObject(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Recognize Qoder's daily-chat-limit rejection. The gateway reports it as
 * `{"code":"110","message":"Billing daily count exceeded"}` inside the envelope
 * body (numeric `110` also appears in some builds).
 */
export function isDailyChatLimitRejection(body: unknown): boolean {
  const root = parseJsonObject(body);
  if (!root) return false;
  const code = root.code;
  return code === DAILY_CHAT_LIMIT_CODE || code === Number(DAILY_CHAT_LIMIT_CODE);
}

/**
 * Recognize Qoder's model-busy envelope and extract the retry hint.
 *
 * Envelope body shape (three nested JSON layers):
 *   {code:"403",message:"{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":false,...}\",\"subCode\":\"RESOURCE_LIMIT\"}"}
 *
 * Only the documented 10605 code with `serviceAvailable:true` is eligible.
 * `subCode` is diagnostic only — it is not a retry signal.
 *
 * - `isQueued:false` ("ready"): the caller may re-send after
 *   `retryAfterSeconds`; the stream loop retries this in-line, bounded.
 * - `isQueued:true` ("queued"): the request sits in a real queue. The
 *   snapshot carries the wait hint, preferring `waitTime` (seconds until
 *   this request's slot) over `retryAfterSeconds` (a minimum re-ask
 *   interval); re-asking at the shorter interval would land at the back
 *   of the queue. The stream loop does NOT sleep on this — it surfaces
 *   a host-schedulable error instead.
 * - Missing flags or any other code: not a busy signal, keep the
 *   previous failure behavior.
 */
export function parseModelBusyRejection(body: unknown): ModelBusyQueueSnapshot | undefined {
  const outer = parseJsonObject(body);
  const busy = parseJsonObject(outer?.message);
  if (busy?.code !== MODEL_BUSY_CODE) return undefined;
  const queue = parseJsonObject(busy.message);
  if (!queue) return undefined;
  if (queue.serviceAvailable !== true) return undefined;
  const seconds = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
    const milliseconds = Math.round(value * 1000);
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : 0;
  };
  if (queue.isQueued === false) {
    return { kind: "ready", retryAfterMs: seconds(queue.retryAfterSeconds) };
  }
  if (queue.isQueued === true) {
    const waitMs = seconds(queue.waitTime) || seconds(queue.retryAfterSeconds);
    const queueCount = typeof queue.queueCount === "number" ? queue.queueCount : undefined;
    const queueType = typeof queue.queueType === "string" ? queue.queueType : undefined;
    return { kind: "queued", waitMs, queueCount, queueType };
  }
  return undefined;
}

/**
 * Format a queued rejection for the host's retry machinery. The text
 * deliberately contains no bare `403` (hosts classify that as an auth
 * failure and never retry), includes a `retry-after-ms=` hint the host
 * can schedule on, and stays retryable under pi-ai's retryable pattern
 * via the truthful "rate limit" token (the queue is a CALL_COUNT_LIMIT
 * throttle). Queue fields are included so a queued failure is
 * distinguishable from an auth failure in logs and transcripts.
 */
export function formatQueuedBusyError(snapshot: Extract<ModelBusyQueueSnapshot, { kind: "queued" }>): Error {
  const waitSeconds = Math.round(snapshot.waitMs / 1000);
  const ahead = snapshot.queueCount !== undefined ? `, ${snapshot.queueCount} ahead` : "";
  const tier = snapshot.queueType ? ` (${snapshot.queueType})` : "";
  return new Error(
    `Qoder model is busy: request queued (10605 CALL_COUNT_LIMIT${tier}${ahead}, ~${waitSeconds}s wait, rate limit, retry-after-ms=${snapshot.waitMs})`,
  );
}

/** Sleep that rejects as soon as the caller aborts. */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Aborted"));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface ToolCallCandidates {
  states: Set<ToolCallState>;
  complete: Set<ToolCallState>;
  unique: ToolCallState | undefined;
}

interface ToolCallState {
  argumentChunks: string[];
  argumentLength: number;
  objectRoot?: boolean;
  depth: number;
  inString: boolean;
  escaped: boolean;
  complete: boolean;
  parsedArguments?: ToolCall["arguments"];
  id: string;
  name: string;
  block?: ToolCall;
  contentIndex: number;
  candidates: Set<ToolCallCandidates>;
  unindexed: boolean;
}

interface ToolCallAggregation {
  states: ToolCallState[];
  byId: Map<string, ToolCallState>;
  byIndex: Map<number, ToolCallCandidates>;
  unscopedCandidates: Set<ToolCallState>;
  statesByBlock: Map<ToolCall, ToolCallState>;
  lastToolState?: ToolCallState;
}

function refreshToolIndexes(output: AssistantMessage, toolCalls: ToolCallAggregation): void {
  const lastToolState = toolCalls.lastToolState;
  if (!lastToolState || output.content[lastToolState.contentIndex] === lastToolState.block) return;
  // ThinkingTagParser.emitThinking() can splice only when creating its first
  // thinking block. All other layout changes append. Refresh in one scan.
  for (let index = 0; index < output.content.length; index++) {
    const block = output.content[index];
    if (block.type !== "toolCall") continue;
    const state = toolCalls.statesByBlock.get(block);
    if (state) state.contentIndex = index;
  }
}

function retireCompleteCandidates(toolCalls: ToolCallAggregation, candidates: ToolCallCandidates): void {
  for (const state of candidates.complete) {
    // Structural closure alone is not sufficient evidence of a boundary.
    parseToolArguments(state);
    candidates.states.delete(state);
    state.candidates.delete(candidates);
    if (state.candidates.size === 0 && !state.unindexed) toolCalls.unscopedCandidates.delete(state);
  }
  candidates.complete.clear();
  candidates.unique = candidates.states.size === 1 ? candidates.states.values().next().value : undefined;
}

const TOOL_ARGUMENT_STRUCTURE = /["\\{}[\]]/g;
const NON_JSON_WHITESPACE = /[^ \t\r\n]/;

/**
 * A tool call that cannot be turned into an executable call: arguments that
 * never parse, or an identity that never arrived. When a payload was also
 * dropped, the caller treats it as the transport failure it is; without one it
 * stays the plain argument error it always was.
 */
class UnusableToolCallError extends Error {}

function invalidToolArguments(state: ToolCallState): Error {
  return new UnusableToolCallError(`Invalid or incomplete tool-call JSON (characters=${state.argumentLength})`);
}

/**
 * Wording is load-bearing: pi-ai classifies assistant errors by message text,
 * and `invalid` (in the plain argument error above) is an explicit
 * non-retryable signal, while `server error` is a retryable one. A stream the
 * gateway cut leaves nothing executable behind, so the host should replay the
 * turn instead of ending the session.
 *
 * The message carries no diagnostic counts: a bare status-code-like token in
 * it (for example, an argument length that happens to be 403) would let a
 * host that vetoes bare 403 as an auth failure classify this retryable
 * failure as non-retryable. Counts live only in the QODER_DEBUG log at the
 * call site, never in the classified message.
 */
function lostToolArgumentStream(): Error {
  return new Error("Qoder server error: tool-call argument stream was cut off (unparseable upstream payload)");
}

// Only locate a possible root-object boundary here. JSON.parse remains the
// authority on grammar; scanning each new fragment avoids parsing prefixes.
function appendToolArguments(state: ToolCallState, fragment: string): void {
  state.argumentChunks.push(fragment);
  state.argumentLength += fragment.length;
  if (state.complete) {
    if (NON_JSON_WHITESPACE.test(fragment)) throw invalidToolArguments(state);
    return;
  }
  let start = 0;
  if (state.objectRoot === undefined) {
    start = fragment.search(NON_JSON_WHITESPACE);
    if (start === -1) return;
    state.objectRoot = fragment[start] === "{";
  }
  if (!state.objectRoot) return;
  if (state.escaped) {
    start = 1;
    state.escaped = false;
  }
  TOOL_ARGUMENT_STRUCTURE.lastIndex = start;
  while (true) {
    const match = TOOL_ARGUMENT_STRUCTURE.exec(fragment);
    if (!match) break;
    const character = match[0];
    if (state.inString) {
      if (character === "\\") {
        if (TOOL_ARGUMENT_STRUCTURE.lastIndex === fragment.length) state.escaped = true;
        else TOOL_ARGUMENT_STRUCTURE.lastIndex++;
      } else if (character === '"') {
        state.inString = false;
      }
    } else if (character === '"') {
      state.inString = true;
    } else if (character === "{" || character === "[") {
      state.depth++;
    } else if (character === "}" || character === "]") {
      state.depth--;
      if (state.depth === 0) {
        state.complete = true;
        if (NON_JSON_WHITESPACE.test(fragment.slice(TOOL_ARGUMENT_STRUCTURE.lastIndex))) {
          throw invalidToolArguments(state);
        }
        return;
      }
    }
  }
}

function parseToolArguments(state: ToolCallState): ToolCall["arguments"] {
  if (state.parsedArguments) return state.parsedArguments;
  let args: unknown = {};
  if (state.argumentLength > 0) {
    try {
      args = JSON.parse(state.argumentChunks.join(""));
    } catch {
      // Do not let the malformed-SSE SyntaxError handler swallow this failure,
      // and never include the parser's message (which can expose arguments).
      throw invalidToolArguments(state);
    }
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new UnusableToolCallError(`Non-object tool-call arguments (characters=${state.argumentLength})`);
  }
  state.parsedArguments = args as ToolCall["arguments"];
  return state.parsedArguments;
}

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

function stableChatRecordID(
  model: string,
  messages: Array<{ role?: string; content?: unknown }>,
  tools: unknown,
  maxTokens: number,
): string {
  const hash = crypto.createHash("sha256");
  hash.update("qoder-record");
  hash.update("\0");
  hash.update(model);
  for (const msg of messages) {
    if (msg?.role) {
      hash.update("\0");
      hash.update(msg.role);
    }
    if (msg?.content) {
      hash.update("\0");
      hash.update(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    }
  }
  if (tools) {
    hash.update("\0");
    hash.update(JSON.stringify(tools));
  }
  hash.update("\0");
  hash.update(`mt=${maxTokens}`);
  return hash.digest("hex").slice(0, 16);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return (part as { text: string }).text;
        return "";
      })
      .join("\n");
  }
  return "";
}

/**
 * The pi-ai transcript helpers we feature-detect at runtime. Derived from the
 * pi-ai namespace so the signatures stay in step; every member is optional
 * because pi-ai <=0.85 does not export them at all.
 */
type TranscriptHelpers = Partial<
  Pick<
    typeof PiAi,
    | "collapseSystemMessages"
    | "getCurrentTools"
    | "getInitialSystemMessage"
    | "getSystemMessageText"
    | "withoutInitialSystemMessage"
  >
>;

/**
 * Resolve the messages, system-prompt text, and tools for the Qoder request
 * from EITHER pi-ai provider contract:
 *
 *  - pi-ai >=0.86 hands providers a `TranscriptContext` (`{ messages }` only):
 *    `normalizeContext()` folds the system prompt and tool declarations into the
 *    transcript's leading system message, so the legacy top-level
 *    `context.systemPrompt` / `context.tools` are undefined. Resolve them via the
 *    transcript helpers, and drop the consolidated leading system message from
 *    the conversation (reqBody re-injects `systemText` as its own role:system
 *    message, because Qoder ignores the top-level `system` field).
 *  - pi-ai <=0.85 hands providers a flat `Context` with top-level
 *    `systemPrompt` / `tools` and no transcript helpers.
 *  - Some >=0.86 hosts hand providers a flat `Context` anyway while still
 *    exporting the transcript toolkit to legacy extensions (omp 18.12.x does:
 *    its compat root exports the helpers, but `streamQoder` receives
 *    `systemPrompt` + `tools` unfolded). The leading system message is what
 *    marks a folded transcript, so its absence means the flat fields still
 *    carry the prompt and tools.
 *
 * The helpers are passed in (as the pi-ai namespace) and feature-detected, so a
 * single bundle runs on all three: on 0.85 the namespace simply lacks them and
 * we use the flat fields. Using a namespace import for this is deliberate — a
 * named import of a 0.86-only export would throw at module-load time on 0.85.
 */
export function resolveRequestContext(
  piAi: TranscriptHelpers,
  context: Context,
): { messages: Message[]; systemText: string; tools: Tool[] } {
  const {
    collapseSystemMessages,
    getCurrentTools,
    getInitialSystemMessage,
    getSystemMessageText,
    withoutInitialSystemMessage,
  } = piAi;

  // Require the FULL transcript toolkit — including getSystemMessageText — before
  // taking the transcript path. If any helper is missing we cannot faithfully
  // reconstruct the prompt + tools from the transcript, so fall back to the flat
  // Context fields rather than silently dropping the system prompt (which is what
  // happens if we resolve tools from the transcript but lack getSystemMessageText:
  // context.systemPrompt is undefined under the >=0.86 contract).
  const hasTranscript =
    typeof collapseSystemMessages === "function" &&
    typeof getCurrentTools === "function" &&
    typeof getInitialSystemMessage === "function" &&
    typeof getSystemMessageText === "function" &&
    typeof withoutInitialSystemMessage === "function";

  if (!hasTranscript) {
    // pi-ai <=0.85: flat Context carries the prompt and tools directly.
    return {
      messages: context.messages,
      systemText: contentToText(context.systemPrompt || ""),
      tools: context.tools ?? [],
    };
  }

  const collapsed = collapseSystemMessages(context as unknown as TranscriptContext);
  const transcriptMessages = collapsed.messages;
  const initialSystem = getInitialSystemMessage(transcriptMessages);

  // The leading system message is the only proof that this host folded
  // `systemPrompt` and `tools` into the transcript. Without it the helpers
  // replay nothing — `getCurrentTools` reads `toolsAdded` off system messages —
  // so a host that exports the toolkit but still passes a flat `Context` would
  // otherwise send `tools: []` and lose the tool-call protocol entirely.
  if (!initialSystem) {
    return {
      messages: context.messages,
      systemText: contentToText(context.systemPrompt || ""),
      tools: context.tools ?? [],
    };
  }

  const tools = getCurrentTools(transcriptMessages);
  const systemText = contentToText(getSystemMessageText?.(initialSystem) ?? context.systemPrompt ?? "");
  const messages = withoutInitialSystemMessage(transcriptMessages);
  return { messages, systemText, tools };
}

export function streamQoder(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const StreamCtor = (PiAi as unknown as { AssistantMessageEventStream: new () => AssistantMessageEventStream })
    .AssistantMessageEventStream;
  const stream = new StreamCtor();

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  // Unparseable upstream payloads dropped by the reader in the current attempt.
  // Shared with the outer catch so every path that gives up on a tool call can
  // tell a truncated stream from a genuinely bad call.
  let droppedPayloads = 0;
  let secretToken = "";

  (async () => {
    try {
      const providerMode = model.provider === "qoder-cn" || model.provider.startsWith("qoder-cn#") ? "cn" : "global";
      const region = getQoderRegionConfig(providerMode);
      const encodedKey = options?.apiKey;
      if (!encodedKey) {
        throw new Error(
          providerMode === "cn"
            ? "Qoder CN credentials not set. Run /login qoder-cn or set QODERCN_PERSONAL_ACCESS_TOKEN."
            : "Qoder credentials not set. Run /login qoder or set QODER_PERSONAL_ACCESS_TOKEN.",
        );
      }

      // Resolve the real Qoder identity from the job token. OMP keeps login
      // credentials in its own agent.db, not in ~/.pi/agent/auth.json, so a
      // cache miss would otherwise send uid "qoder-user" and Qoder CN rejects
      // it with "Login expired" (105).
      const ident = await resolveQoderIdentity(encodedKey, model.provider, providerMode, options?.signal);
      const accessToken = ident.access;
      secretToken = accessToken;
      const userID = ident.userID || "qoder-user";
      const name = ident.name || region.userNameFallback;
      const email = ident.email || region.userEmailFallback;
      const machineID = ident.machineID || getMachineId();

      // Both providers expose the upstream display_name (whitespace stripped)
      // as the pi id. Read the original key from cached/static config so the
      // gateway still receives identifiers such as `lite` or `qmodel`.
      const modelConfig = getCachedModelConfig(model.id, providerMode, userID);
      if (!modelConfig?.key) {
        throw new Error(`Unknown Qoder model id: ${model.id}`);
      }
      const qoderModel = modelConfig.key;

      const isReasoning = !!modelConfig.is_reasoning;

      // Resolve messages / system prompt / tools from whichever pi-ai contract
      // is running (>=0.86 TranscriptContext, or <=0.85 flat Context). The
      // transcript helpers are feature-detected inside, so one bundle runs on
      // both. See resolveRequestContext.
      const resolved = resolveRequestContext(PiAi, context);
      const normalizedMessages = transformMessagesForQoder(resolved.messages);
      // OMP may supply the system prompt as a single-element content array;
      // Qoder MessagesInputDto#content is a String and rejects an array with
      // "Execution failed: set property ... MessagesInputDto#content". Normalize.
      const systemText = resolved.systemText;

      let lastUserText = "";
      for (let i = normalizedMessages.length - 1; i >= 0; i--) {
        if (normalizedMessages[i].role === "user") {
          const content = normalizedMessages[i].content;
          lastUserText =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map((c) => ("text" in c ? c.text : "")).join("")
                : "";
          break;
        }
      }

      // Use a stable session id when pi provides one (per agent session) so
      // the Qoder server can maintain prompt cache affinity across consecutive
      // requests. Fall back to a random id only when no sessionId is available.
      const stablePart = stableHash("qoder-session", userID, qoderModel);
      const sessionID = options?.sessionId
        ? `${stablePart}-${options.sessionId}`
        : `${stablePart}-${crypto.randomUUID()}`;

      // Qoder's catalog exposes no per-model output cap, so we use the
      // documented upstream ceiling (MAX_OUTPUT_TOKENS = 131072, see models.ts)
      // and let pi cap it lower when the caller sets options.maxTokens (e.g.
      // compaction at 40K). This avoids truncating reasoning chains / long
      // generations that the 32K default would cut off.
      let maxTokens = MAX_OUTPUT_TOKENS;
      if (options?.maxTokens && options.maxTokens < maxTokens) {
        maxTokens = options.maxTokens;
      }

      // resolved.tools already prefers the transcript (pi-ai >=0.86) and falls
      // back to the legacy top-level context.tools (<=0.85). Without a bound
      // tool list the request ships `tools: []`, the model gets no function
      // schema, and it free-forms ChatML tool calls as plain text that never
      // execute — the regression this fixes.
      const toolsRaw = resolved.tools.length > 0 ? transformTools(resolved.tools) : undefined;
      const recordID = stableChatRecordID(qoderModel, normalizedMessages, toolsRaw, maxTokens);

      // Map pi's thinking level (options.reasoning) to Qoder's request fields.
      // Confirmed from @qoder-ai/qodercli: the chat body carries `reasoning_effort`
      // ("none"|"low"|"medium"|"high"|"xhigh"|"max") and `enable_thinking` (bool)
      // inside `parameters`, alongside `max_tokens`.
      //
      // This mirrors the pattern the pi-ai OpenAI provider uses: clamp the
      // requested level to what the model advertises via thinkingLevelMap, then
      // map to the upstream effort name. clampThinkingLevel returns "off" when
      // the level is unsupported or the user disabled thinking.
      const requestedLevel = options?.reasoning;

      // Normalize every host's "thinking off" signal into one flag. pi and OMP
      // both resolve level "off" to `reasoning: undefined`; OMP's fork also sets
      // `disableReasoning` / `forceReasoningOff`; `false` / `"off"` cover older
      // hosts. When off, skip clamping so the request never snaps back up to a
      // concrete level.
      const extOptions = options as
        | (SimpleStreamOptions & { disableReasoning?: boolean; forceReasoningOff?: boolean })
        | undefined;
      const explicitlyOff =
        extOptions?.disableReasoning === true ||
        extOptions?.forceReasoningOff === true ||
        (requestedLevel as unknown) === false ||
        (requestedLevel as unknown) === "off";

      // `undefined` here (explicit off, omitted level, or clamped to off) means
      // "disable thinking"; the else branch below turns it into the wire signals.
      const clamped = !explicitlyOff && requestedLevel ? clampThinkingLevel(model, requestedLevel) : undefined;
      const reasoningLevel = clamped === "off" ? undefined : clamped;
      const parameters: Record<string, unknown> = { max_tokens: maxTokens };
      if (reasoningLevel) {
        parameters.enable_thinking = true;
        // Effort-based models advertise concrete effort names in the map
        // (low/medium/xhigh/max). Toggle-only models map every level to
        // "enabled"/"disabled" and accept no effort value — only the on/off
        // switch matters, so we send enable_thinking alone.
        const mapped = model.thinkingLevelMap?.[reasoningLevel];
        const effort = mapped && mapped !== "enabled" && mapped !== "disabled" ? mapped : reasoningLevel;
        // Only send reasoning_effort when the upstream model actually exposes
        // effort levels (thinking_config.enabled.efforts).
        if (modelConfig?.thinking_config?.enabled?.efforts && typeof effort === "string") {
          parameters.reasoning_effort = effort;
        }
      } else {
        // Explicitly disable thinking. `enable_thinking: false` alone is not
        // enough: qodercli also sends `reasoning_effort: "none"` (and flips
        // `model_config.is_reasoning` below), otherwise the gateway still
        // routes the reasoning model as reasoning-enabled.
        //
        // Exception: when the catalog positively shows the model has no
        // disabled branch (effort-based thinking_config without `disabled`,
        // or thinkingLevelMap pinning `off` to null), some upstreams reject
        // `reasoning_effort: "none"` outright (Sonus: 400 "Unsupported
        // value: 'none'"). For those, omit the effort signal — the request
        // stays valid and `enable_thinking: false` is the strongest disable
        // the upstream accepts. With no catalog signal either way (static
        // fallback / tests), keep sending "none".
        parameters.enable_thinking = false;
        const tc = modelConfig?.thinking_config;
        const lacksDisabledBranch = (tc?.enabled?.efforts && !tc.disabled) || model.thinkingLevelMap?.off === null;
        if (!lacksDisabledBranch) {
          parameters.reasoning_effort = "none";
        }
      }

      let reqBody: Record<string, unknown> = {
        request_id: crypto.randomUUID(),
        request_set_id: recordID,
        chat_record_id: recordID,
        session_id: sessionID,
        stream: true,
        chat_task: "FREE_INPUT",
        is_reply: true,
        is_retry: false,
        source: 1,
        version: "3",
        session_type: "qodercli",
        agent_id: "agent_common",
        task_id: "common",
        code_language: "",
        chat_prompt: "",
        image_urls: null,
        aliyun_user_type: "",
        // Qoder's server ignores the top-level `system` field (verified: the
        // model never sees it). Inject the system prompt as a leading
        // role:system message instead, which the server does honor.
        system: "",
        messages: systemText ? [{ role: "system", content: systemText }, ...normalizedMessages] : normalizedMessages,
        tools: toolsRaw || [],
        parameters,
        chat_context: {
          chatPrompt: "",
          imageUrls: null,
          extra: {
            context: [],
            modelConfig: {
              key: qoderModel,
              is_reasoning: reasoningLevel ? isReasoning : false,
            },
            originalContent: lastUserText,
          },
          features: [],
          text: lastUserText,
        },
        model_config: reasoningLevel ? modelConfig : { ...modelConfig, is_reasoning: false },
        business: {
          product: "cli",
          version: "1.0.0",
          type: "agent",
          stage: "start",
          id: crypto.randomUUID(),
          name: lastUserText.substring(0, 30),
          begin_at: Date.now(),
        },
      };

      const chatPath = "algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
      let chatBase = getQoderBaseUrl(providerMode);
      let chatURL = `${chatBase}${chatPath}`;
      let discoveredNodes: string[] | undefined;
      const attemptedNodes = new Set<string>();
      const modelSource = modelConfig.source || "system";

      // A caller-provided retry budget (including an explicit 0) wins; otherwise
      // retry twice, capped at qodercli's own recovery limit. Non-finite values
      // fall back to the default so the caps stay finite.
      const requestedRetries = options?.maxRetries;
      const modelBusyRetries = Math.min(
        Math.max(
          0,
          typeof requestedRetries === "number" && Number.isFinite(requestedRetries)
            ? Math.floor(requestedRetries)
            : DEFAULT_MODEL_BUSY_RETRIES,
        ),
        MAX_MODEL_BUSY_RETRIES,
      );
      // pi's contract: `maxRetryDelayMs: 0` disables the caller cap. The
      // provider's own 5s cap still applies, so a positive retryAfterSeconds is
      // never truncated to zero.
      const requestedMaxWaitMs = options?.maxRetryDelayMs;
      const modelBusyMaxWaitMs =
        typeof requestedMaxWaitMs === "number" && Number.isFinite(requestedMaxWaitMs) && requestedMaxWaitMs > 0
          ? Math.min(MODEL_BUSY_MAX_WAIT_MS, requestedMaxWaitMs)
          : MODEL_BUSY_MAX_WAIT_MS;

      const replacement = await options?.onPayload?.(reqBody, model);
      if (replacement !== undefined) {
        if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)) throw new Error('Invalid Qoder request payload');
        reqBody = replacement as Record<string, unknown>;
      }
      let encodedBytes = qoderEncodeBody(Buffer.from(JSON.stringify(reqBody)));
      let headers = buildAuthHeaders(encodedBytes, chatURL, {
        userID,
        authToken: accessToken,
        name,
        email,
        machineID,
      });

      const thinkingEnabled = (options?.reasoning as unknown) !== false && (options?.reasoning as unknown) !== "off";

      // Exactly one `start` per logical stream: recovery retries reuse it.
      stream.push({ type: "start", partial: output });

      const runAttempt = async (): Promise<void> => {
        // Reset every mutable output field BEFORE the request: a failed attempt
        // may otherwise leak metadata, usage (including Qoder credits) or a
        // finish_reason into the attempt that succeeds, or into the terminal
        // error when the next attempt fails at fetch/HTTP level.
        options?.signal?.throwIfAborted();
        output.stopReason = "stop";
        output.errorMessage = undefined;
        output.responseId = undefined;
        output.responseModel = undefined;
        output.usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };

        const response = await (options?.fetch ?? fetch)(chatURL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "Cache-Control": "no-cache",
            "Accept-Encoding": "identity",
            "X-Model-Key": qoderModel,
            "X-Model-Source": modelSource,
            ...headers,
          },
          body: encodedBytes as unknown as BodyInit,
          // Credentials and the conversation are in the body; never replay them to a redirect target.
          redirect: "manual",
          signal: options?.signal,
        });
        await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);

        if (!response.ok) {
          const errText = await response.text();
          if (isDailyChatLimitRejection(errText)) {
            // The same 110 rejection can also arrive as a plain HTTP error
            // instead of an SSE envelope; rotate nodes for it the same way.
            // The response headers just arrived, so no model output has been
            // seen yet and the retry is safe.
            throw new QoderDailyChatLimitError(`Upstream status ${response.status}`, false);
          }
          throw new Error(`Qoder API request failed: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder();
        let buffer = "";
        let bufferStart = 0;

        let contentBlockIndex = -1;
        let thinkingBlockIndex = -1;
        // Tail of the reasoning channel before DSML residue is stripped. Only the
        // tail matters (the degenerate-turn check looks for trailing markup), so
        // this stays bounded instead of growing with the reply.
        let rawReasoningTail = "";
        let toolCalls: ToolCallAggregation | undefined;

        const thinkingParser = thinkingEnabled ? new ThinkingTagParser(output, stream) : null;

        let sawModelOutput = false;
        // A `data:` payload the gateway or a proxy cut in half is dropped below.
        // Counted per attempt (declared outside): a dropped payload silently
        // shortens tool-call arguments, and the turn must not die as an
        // unrelated argument error.
        droppedPayloads = 0;

        // `data: [DONE]` is the end of the response. Break the read loop too, not
        // just the line loop: Qoder's gateway keeps the HTTP body open after the
        // sentinel, so waiting for `done` from reader.read() hung until the
        // server or the OS eventually closed the socket. The full reply had
        // already been streamed by then, so the agent looked stuck with no error.
        let sawDone = false;

        try {
          while (!sawDone) {
            const { done, value } = await reader.read();

            // Drop consumed prefix before appending so we do not keep growing a
            // dead head of the string across chunks.
            if (bufferStart > 0) {
              buffer = buffer.substring(bufferStart);
              bufferStart = 0;
            }
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            // The connection closed without a final newline: parse the remaining
            // line too, and count it as lost output if it was cut in half.
            const unterminatedTail = done && buffer.trim() !== "";
            if (done) buffer += "\n";

            while (true) {
              const lineEnd = buffer.indexOf("\n", bufferStart);
              if (lineEnd === -1) break;

              const line = buffer.substring(bufferStart, lineEnd).trim();
              bufferStart = lineEnd + 1;

              if (!line.startsWith("data:")) continue;

              const dataStr = line.substring(5).trim();
              if (dataStr === "[DONE]") {
                sawDone = true;
                break;
              }

              // Which JSON the SyntaxError came from decides whether the line
              // was noise (envelope) or lost model output (payload).
              let parsePhase: "envelope" | "payload" = "envelope";
              try {
                const envelope = JSON.parse(dataStr);
                if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
                  const busy = parseModelBusyRejection(envelope.body);
                  if (busy?.kind === "ready") {
                    throw new QoderModelBusyError(
                      `Upstream status ${envelope.statusCodeValue}`,
                      busy.retryAfterMs,
                      sawModelOutput,
                    );
                  }
                  if (busy?.kind === "queued") {
                    // A queued rejection that arrives after partial output
                    // must not be host-retried: re-running the turn would
                    // duplicate the content already emitted.
                    if (sawModelOutput) {
                      throw new Error("Qoder model rejected the request after partial output (10605 RESOURCE_LIMIT)");
                    }
                    throw formatQueuedBusyError(busy);
                  }
                  if (isDailyChatLimitRejection(envelope.body)) {
                    // Another chat node may still serve this account; the
                    // wrapper below switches and retries once per node.
                    throw new QoderDailyChatLimitError(
                      `Upstream status ${envelope.statusCodeValue}`,
                      sawModelOutput,
                    );
                  }
                  throw new Error(`Upstream status ${envelope.statusCodeValue}`);
                }

                const innerStr = envelope.body;
                // The gateway sends the sentinel wrapped in an envelope
                // (`body: "[DONE]"`) as well as bare, and both mean the reply is
                // over, so both have to end the read loop.
                if (innerStr === "[DONE]") {
                  sawDone = true;
                  break;
                }
                if (!innerStr) continue;

                parsePhase = "payload";
                const inner = JSON.parse(innerStr);
                await options?.onProviderStreamEvent?.(inner, model);
                if (inner.id) output.responseId = inner.id as string;
                if (inner.model) output.responseModel = inner.model as string;
                if (inner.usage) {
                  applyQoderCredits(output.usage, inner.usage, providerMode === "cn" ? "qoder-cn" : "qoder");
                  const u = inner.usage as {
                    prompt_tokens?: number;
                    completion_tokens?: number;
                    total_tokens?: number;
                    completion_tokens_details?: { reasoning_tokens?: number };
                    prompt_tokens_details?: {
                      cacheable_tokens?: number;
                      cached_tokens?: number;
                      cache_write_tokens?: number;
                    };
                  };
                  // pi-core computes `promptTokens = input + cacheRead + cacheWrite`
                  // (Anthropic convention: `input` EXCLUDES cached/written tokens).
                  // Qoder follows OpenAI semantics where `prompt_tokens` INCLUDES
                  // `cached_tokens`, so subtract cacheRead (and cache_write_tokens
                  // when reported) to match the contract pi-ai's own OpenAI
                  // provider uses. `cacheable_tokens` is a capacity metric, not a
                  // write count (it is 0 even on first-turn writes), so it is NOT
                  // mapped to cacheWrite.
                  const promptTokens = u.prompt_tokens ?? 0;
                  const cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
                  const cacheWriteTokens = u.prompt_tokens_details?.cache_write_tokens ?? 0;
                  output.usage.input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
                  output.usage.output = u.completion_tokens ?? 0;
                  output.usage.totalTokens = u.total_tokens ?? 0;
                  output.usage.cacheRead = cacheReadTokens;
                  output.usage.cacheWrite = cacheWriteTokens;
                }
                if (inner.choices && inner.choices.length > 0) {
                  const choice = inner.choices[0];
                  const delta = choice.delta;

                  if (delta) {
                    // Any raw generation field ends recovery for this stream: a
                    // retry could duplicate text, thinking, or tool arguments
                    // (including fragments still buffered in the tag parser).
                    if (
                      delta.reasoning_content ||
                      delta.content ||
                      (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
                    ) {
                      sawModelOutput = true;
                    }
                    // 1. Process reasoning/thinking content (API reasoning)
                    if (delta.reasoning_content) {
                      // Qoder's backend sometimes routes a literal `<thinking>`
                      // opener into reasoning_content (with the matching
                      // `</thinking>` closer landing in the content stream), and
                      // sometimes leaks unparsed DSML tool-call markup there. Strip
                      // both so the thinking block stays clean, matching the SDK's
                      // ContentBlock model.
                      rawReasoningTail = (rawReasoningTail + delta.reasoning_content).slice(-512);
                      const reasoningChunk = stripDsmlResidue(stripThinkingTags(delta.reasoning_content));
                      if (reasoningChunk) {
                        if (thinkingBlockIndex === -1) {
                          thinkingBlockIndex = output.content.length;
                          output.content.push({ type: "thinking", thinking: "" });
                          stream.push({ type: "thinking_start", contentIndex: thinkingBlockIndex, partial: output });
                        }
                        const block = output.content[thinkingBlockIndex] as ThinkingContent;
                        block.thinking += reasoningChunk;
                        stream.push({
                          type: "thinking_delta",
                          contentIndex: thinkingBlockIndex,
                          delta: reasoningChunk,
                          partial: output,
                        });
                      }
                    }

                    // 2. Process text content
                    if (delta.content) {
                      // End API thinking block if active
                      if (thinkingBlockIndex !== -1) {
                        const block = output.content[thinkingBlockIndex] as ThinkingContent;
                        stream.push({
                          type: "thinking_end",
                          contentIndex: thinkingBlockIndex,
                          content: block.thinking,
                          partial: output,
                        });
                        thinkingBlockIndex = -1;
                      }

                      if (thinkingParser) {
                        thinkingParser.processChunk(delta.content);
                        if (toolCalls?.lastToolState) refreshToolIndexes(output, toolCalls);
                      } else {
                        if (contentBlockIndex === -1) {
                          contentBlockIndex = output.content.length;
                          output.content.push({ type: "text", text: "" });
                          stream.push({ type: "text_start", contentIndex: contentBlockIndex, partial: output });
                        }
                        const block = output.content[contentBlockIndex] as TextContent;
                        block.text += delta.content;
                        stream.push({
                          type: "text_delta",
                          contentIndex: contentBlockIndex,
                          delta: delta.content,
                          partial: output,
                        });
                      }
                    }

                    // 3. Process tool calls
                    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                      for (const tc of delta.tool_calls) {
                        const id = tc.id || "";
                        const name = tc.function?.name || "";
                        const argDelta = tc.function?.arguments ?? "";
                        if (typeof id !== "string" || typeof name !== "string") {
                          throw new Error("Tool-call identity conflict: invalid metadata");
                        }
                        if (typeof argDelta !== "string") throw new Error("Invalid tool-call argument fragment");
                        if (!id && !name && !argDelta) continue;

                        toolCalls ??= {
                          states: [],
                          byId: new Map(),
                          byIndex: new Map(),
                          unscopedCandidates: new Set(),
                          statesByBlock: new Map(),
                        };
                        const index = typeof tc.index === "number" ? tc.index : undefined;
                        let candidates: ToolCallCandidates | undefined;
                        if (index !== undefined) {
                          candidates = toolCalls.byIndex.get(index);
                          if (!candidates) {
                            candidates = { states: new Set(), complete: new Set(), unique: undefined };
                            toolCalls.byIndex.set(index, candidates);
                          }
                        }
                        let state = id ? toolCalls.byId.get(id) : undefined;
                        let associated = !!state && !!candidates && candidates.states.has(state);
                        if (id && candidates && !associated && candidates.complete.size > 0) {
                          retireCompleteCandidates(toolCalls, candidates);
                        }
                        const available = candidates?.states ?? toolCalls.unscopedCandidates;
                        if (!state) {
                          const only =
                            available.size === 1
                              ? candidates
                                ? candidates.unique
                                : available.values().next().value
                              : undefined;
                          if (!id && available.size > 1) {
                            throw new Error(`Ambiguous tool-call continuation (candidates=${available.size})`);
                          }
                          // An explicit new ID never overwrites another identity.
                          // Only a unique, still-unidentified provisional can bind.
                          if (only && (!id || !only.id)) {
                            state = only;
                            associated = candidates !== undefined;
                          } else {
                            state = {
                              argumentChunks: [],
                              argumentLength: 0,
                              depth: 0,
                              inString: false,
                              escaped: false,
                              complete: false,
                              id: "",
                              name: "",
                              contentIndex: -1,
                              candidates: new Set(),
                              unindexed: index === undefined,
                            };
                            toolCalls.states.push(state);
                          }
                        }
                        if (name && state.name && name !== state.name) {
                          throw new Error("Tool-call identity conflict: inconsistent name");
                        }
                        const newlyIdentified = !!id && !state.id;
                        const newlyNamed = !!name && !state.name;
                        if (newlyIdentified) {
                          state.id = id;
                          toolCalls.byId.set(id, state);
                        }
                        if (newlyNamed) state.name = name;
                        if (!associated) {
                          // Indexed continuations already have all three links.
                          // Unindexed explicit IDs can reactivate retired states.
                          toolCalls.unscopedCandidates.add(state);
                          if (candidates) {
                            state.unindexed = false;
                            state.candidates.add(candidates);
                            candidates.states.add(state);
                            candidates.unique = candidates.states.size === 1 ? state : undefined;
                            if (state.complete && state.id) candidates.complete.add(state);
                          }
                        }

                        const wasComplete = state.complete;
                        if (argDelta) appendToolArguments(state, argDelta);
                        if (state.complete && state.id && (!wasComplete || newlyIdentified)) {
                          // Each association is registered at most once on closure,
                          // not revisited on every fragment or repeated ID.
                          for (const scope of state.candidates) scope.complete.add(state);
                        }

                        if (!state.block && (state.id || state.name)) {
                          state.block = { type: "toolCall", id: state.id, name: state.name, arguments: {} };
                          state.contentIndex = output.content.length;
                          output.content.push(state.block);
                          toolCalls.statesByBlock.set(state.block, state);
                          toolCalls.lastToolState = state;
                          stream.push({ type: "toolcall_start", contentIndex: state.contentIndex, partial: output });
                          // Argument-only provisional fragments have no content
                          // position until this block exists. Replay them in order.
                          for (const fragment of state.argumentChunks) {
                            stream.push({
                              type: "toolcall_delta",
                              contentIndex: state.contentIndex,
                              delta: fragment,
                              partial: output,
                            });
                          }
                        } else if (state.block) {
                          if (newlyIdentified) state.block.id = state.id;
                          if (newlyNamed) state.block.name = state.name;
                          if (argDelta) {
                            stream.push({
                              type: "toolcall_delta",
                              contentIndex: state.contentIndex,
                              delta: argDelta,
                              partial: output,
                            });
                          }
                        }
                      }
                    }
                  }

                  if (choice.finish_reason) {
                    // Preserve the real upstream finish_reason (e.g. "length",
                    // "content_filter") instead of forcing "stop" later.
                    output.stopReason = choice.finish_reason as AssistantMessage["stopReason"];
                  }
                }
              } catch (e) {
                // A single malformed SSE line shouldn't kill the stream — skip it.
                // But a genuine upstream error (thrown below) must propagate to the
                // outer catch and surface as stopReason="error", not be swallowed.
                if (e instanceof SyntaxError) {
                  // An unparseable envelope is keepalive noise. An unparseable
                  // payload is model output we will never see; it has to be
                  // accounted for, or the turn ends as an unexplained
                  // "invalid arguments" failure that no retry policy covers.
                  if (parsePhase === "payload" || unterminatedTail) droppedPayloads += 1;
                  continue;
                }
                throw e;
              }
            }
            if (done) break;
          }
        } finally {
          // Release on DONE, abort, and identity/argument failures alike.
          try {
            await reader.cancel().catch(() => {});
          } finally {
            reader.releaseLock();
          }
        }

        if (thinkingParser) {
          thinkingParser.finalize();
          if (toolCalls?.lastToolState) refreshToolIndexes(output, toolCalls);
        }

        if (thinkingBlockIndex !== -1) {
          const block = output.content[thinkingBlockIndex] as ThinkingContent;
          stream.push({
            type: "thinking_end",
            contentIndex: thinkingBlockIndex,
            content: block.thinking,
            partial: output,
          });
        }

        if (toolCalls) {
          // Validate the whole batch before publishing any successful end event.
          for (const state of toolCalls.states) {
            if (!state.id || !state.name) {
              throw new UnusableToolCallError(`Unresolved tool-call identity (characters=${state.argumentLength})`);
            }
            // Validation only: the terminal classification happens once, in the
            // stream's outer catch, so every site that gives up on a call — this
            // loop, the identity check above, and the mid-stream argument
            // accumulator — reports the same failure the same way.
            parseToolArguments(state);
          }
          // Map insertion order is the order calls first became identifiable,
          // independent of sparse/reused upstream indexes and provisional buffers.
          for (const [block, state] of toolCalls.statesByBlock) {
            block.arguments = parseToolArguments(state);
            stream.push({
              type: "toolcall_end",
              contentIndex: state.contentIndex,
              toolCall: block,
              partial: output,
            });
          }

          if (toolCalls.statesByBlock.size > 0 && output.stopReason !== "length") {
            output.stopReason = "toolUse";
          }
        }
        // A turn the gateway stripped the tool call out of has no text and no tool
        // call, so `stop` reads as a finished task: the agent loop ends the turn
        // and the work dies with no error to retry. Report it instead.
        if (isDegenerateDsmlTurn(output, rawReasoningTail)) {
          output.stopReason = "error";
          // "server error" is deliberate: pi-ai classifies an assistant error by
          // matching its message (RETRYABLE_PROVIDER_ERROR_PATTERN), and that
          // phrase is what makes the turn retryable instead of a dead end.
          output.errorMessage =
            "Qoder server error: degenerate model output (unparseable DSML tool-call markup, no tool call executed)";
          stream.push({ type: "error", reason: "error", error: output });
          stream.end();
          return;
        }

        // Otherwise keep whatever finish_reason set upstream (defaults to "stop").
        // Never overwrite a meaningful finish_reason ("length", "content_filter",
        // ...) with "stop".
        stream.push({
          type: "done",
          reason: output.stopReason as Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">,
          message: output,
        });
        stream.end();
      };

      for (let attempt = 0; ; attempt++) {
        try {
          await runAttempt();
          return;
        } catch (e) {
          if (e instanceof QoderDailyChatLimitError) {
            if (e.sawModelOutput || output.content.length > 0) throw e;
            options?.signal?.throwIfAborted();
            attemptedNodes.add(chatBase);
            discoveredNodes ??= await discoverChatEndpoints(providerMode, {
              userID, authToken: accessToken, name, email, machineID,
            }, options?.fetch ?? fetch, options?.signal);
            options?.signal?.throwIfAborted();
            const nextNode = discoveredNodes.find(node => !attemptedNodes.has(node));
            if (!nextNode || attemptedNodes.size >= 4) throw e;
            chatBase = nextNode;
            chatURL = `${chatBase}${chatPath}`;
            headers = buildAuthHeaders(encodedBytes, chatURL, {
              userID, authToken: accessToken, name, email, machineID,
            });
            continue;
          }
          if (!(e instanceof QoderModelBusyError)) throw e;
          if (e.sawModelOutput || output.content.length > 0) {
            // Keep this wording out of pi-ai's retryable pattern: retrying a
            // turn that already emitted content would duplicate it.
            throw new Error("Qoder model rejected the request after partial output (10605 RESOURCE_LIMIT)");
          }
          const requestedWaitMs = e.retryAfterMs ?? 0;
          if (attempt >= modelBusyRetries) {
            throw new QoderModelBusyError(
              `Qoder server error: model is busy (10605 RESOURCE_LIMIT, retryAfterSeconds=${Math.round(requestedWaitMs / 1000)}, attempts=${attempt + 1})`,
              requestedWaitMs,
            );
          }
          if (requestedWaitMs > modelBusyMaxWaitMs) {
            throw new QoderModelBusyError(
              `Qoder server error: model is busy (10605 RESOURCE_LIMIT, requested delay ${requestedWaitMs}ms exceeds local cap ${modelBusyMaxWaitMs}ms)`,
              requestedWaitMs,
            );
          }
          await sleepWithAbort(requestedWaitMs, options?.signal);
          // Covers an abort that lands between the wait and the next attempt.
          options?.signal?.throwIfAborted();
          // qodercli resets request_id and chat_record_id to ONE new value per
          // recovery attempt and keeps request_set_id, so the server can
          // correlate the retry with the same request set.
          const nextId = crypto.randomUUID();
          reqBody.request_id = nextId;
          reqBody.chat_record_id = nextId;
          encodedBytes = qoderEncodeBody(Buffer.from(JSON.stringify(reqBody)));
          headers = buildAuthHeaders(encodedBytes, chatURL, {
            userID,
            authToken: accessToken,
            name,
            email,
            machineID,
          });
        }
      }
    } catch (e: unknown) {
      const aborted = options?.signal?.aborted === true;
      if (!aborted && droppedPayloads > 0 && e instanceof UnusableToolCallError) {
        // Nothing executable has been published either way, so a lost payload is
        // a transport failure whether or not the turn already streamed text. A
        // host that replays a classified error drops the failed assistant turn
        // from the context it re-sends (omp 18.x removes it as `auto-retry`), so
        // streamed text neither vetoes the retry nor survives into it.
        //
        // The terminal message must not be `output` itself: toolcall_start/delta
        // events already queued carry `partial: output`, and removing their
        // blocks from it would leave event.partial.content[contentIndex]
        // undefined. Publish a tool-call-free copy and leave `output` alone.
        if (process.env.QODER_DEBUG) {
          console.error(
            `[pi-provider-qoder] lost tool-call argument stream: ${e.message}, droppedPayloads=${droppedPayloads}`,
          );
        }
        const terminal: AssistantMessage = {
          ...output,
          content: output.content.filter((block) => block.type !== "toolCall"),
          stopReason: "error",
          errorMessage: lostToolArgumentStream().message,
        };
        stream.push({ type: "error", reason: "error", error: terminal });
        try {
          stream.end();
        } catch {}
        return;
      }
      // Cancellation outranks recovery: an aborted turn keeps `aborted`, never a
      // retry-classified server error for a turn the user cancelled.
      output.stopReason = aborted ? "aborted" : "error";
      let errorMessage = e instanceof Error ? e.message : String(e);
      if (secretToken) errorMessage = errorMessage.replaceAll(secretToken, "[redacted]");
      if (options?.apiKey) errorMessage = errorMessage.replaceAll(options.apiKey, "[redacted]");
      output.errorMessage = errorMessage;
      stream.push({ type: "error", reason: output.stopReason, error: output });
      try {
        stream.end();
      } catch {}
    }
  })();

  return stream;
}
