import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { JSException, type JSValueHandle, QuickJS } from 'quickjs-wasi';

const require = createRequire(import.meta.url);
let wasmModule: Promise<WebAssembly.Module> | undefined;

function loadQuickJsWasm(): Promise<WebAssembly.Module> {
  wasmModule ??= readFile(require.resolve('quickjs-wasi/quickjs.wasm')).then((bytes) =>
    WebAssembly.compile(bytes)
  );
  return wasmModule;
}

const TIMEOUT_MS = 30_000;
const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const MAX_TOOL_CALLS = 64;
const MAX_INFLIGHT = 16;
const MAX_OUTPUT_BYTES = 8 * 1024;

const FORBIDDEN_GUEST_TOOLS = new Set([
  'exec',
  'wait',
  'subagent',
  'coworker',
  'message_coworker',
  'message_main_agent',
  'explore_mark',
  'explore_fold',
  'goal_complete',
  'goal_blocked',
  'goal_wait',
  'ask_user',
  'todo',
  'task_output',
  'task_stop',
]);

const SHELL_HEAD =
  /^(cd|ls|git|npm|pnpm|yarn|cat|echo|rm|mkdir|chmod|sudo|curl|wget|python|pip|brew|head|tail|grep|rg)\b/;

export interface IsolatedSandboxToolOptions {
  getTools: () => readonly ToolDefinition[];
  /** 会话级 JSON 仓，跨多次 exec 的 store/load */
  store?: Map<string, unknown>;
}

interface HostCall {
  id: string;
  name: string;
  args: unknown;
}

export function looksLikeShellCommand(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  if (/\b(await|const|let|var|function|return)\b/.test(trimmed) || trimmed.includes('=>')) {
    return false;
  }
  if (/^\w+\(/.test(trimmed)) return false;
  return SHELL_HEAD.test(trimmed);
}

function jsonClone(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}

const RESERVED_CALLABLES = new Set([
  'catalog',
  'store',
  'load',
  'tools',
  'JSON',
  'Promise',
  'Object',
  'Array',
  'Map',
  'Set',
  'Error',
  'String',
  'Math',
  'Date',
  'console',
  'Function',
  'undefined',
  ...FORBIDDEN_GUEST_TOOLS,
]);

export function guestCallableName(name: string, taken: Set<string>): string {
  let base = name
    .replace(/[^A-Za-z0-9_$]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (!base) base = 'tool';
  if (!/^[A-Za-z_$]/.test(base)) base = `tool_${base}`;
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) candidate = `${base}_${suffix++}`;
  taken.add(candidate);
  return candidate;
}

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function guestResult(result: {
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}): unknown {
  return jsonClone({
    content: textOf(result),
    details: result.details,
    isError: result.isError === true,
  });
}

function suggestCallable(missing: string, names: readonly string[]): string | undefined {
  const normalized = missing.replace(/-/g, '_').replace(/_+/g, '_');
  if (names.includes(normalized) && normalized !== missing) return normalized;
  return names.find((name) => name === normalized || name.endsWith(`_${normalized}`));
}

function withDidYouMean(message: string, names: readonly string[]): string {
  const match = /([A-Za-z_$][\w$]*)\s+is not defined/.exec(message);
  const missing = match?.[1];
  if (!missing) return message;
  const hint = suggestCallable(missing, names);
  const rule = 'Tool names replace "-" and "__" with "_" (mcp__foo__bar → mcp_foo_bar).';
  if (hint) return `${message} Did you mean ${hint}? ${rule}`;
  if (missing.includes('mcp') || missing.includes('__')) return `${message} ${rule}`;
  return message;
}

function dropQueued(
  queue: HostCall[],
  calls: Array<{ name: string; ok: boolean; error?: string; summary?: string }>
): void {
  while (queue.length > 0) {
    const job = queue.shift();
    if (!job) break;
    const summary = callSummary(job.args);
    calls.push({
      name: job.name,
      ok: false,
      error: 'dropped',
      ...(summary ? { summary } : {}),
    });
  }
}

function callSummary(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const value = record.path ?? record.command ?? record.pattern ?? record.query;
  return typeof value === 'string' && value ? value.slice(0, 80) : undefined;
}

function slimCalls(calls: Array<{ name: string; ok: boolean; error?: string; summary?: string }>) {
  return calls.map(({ summary: _summary, ...rest }) => rest);
}

function packGuestOutput(details: {
  status: 'completed' | 'failed';
  value?: unknown;
  error?: string;
  calls: unknown[];
}): { text: string; details: Record<string, unknown> } {
  const rawValue =
    typeof details.value === 'string' ? details.value : (JSON.stringify(details.value) ?? '');
  let value: unknown = details.value;
  let error = details.error;
  let calls = details.calls.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const rec = entry as Record<string, unknown>;
    if (typeof rec.name !== 'string' || !rec.name) return [];
    return [
      {
        name: rec.name,
        ok: rec.ok === true,
        ...(typeof rec.error === 'string' ? { error: rec.error } : {}),
        ...(typeof rec.summary === 'string' ? { summary: rec.summary } : {}),
      },
    ];
  });
  let hint: string | undefined;
  let omittedCalls = 0;

  const build = () => {
    const packed: Record<string, unknown> = { status: details.status, calls };
    if (details.status === 'completed') packed.value = value;
    if (details.status === 'failed') packed.error = error;
    if (hint) {
      packed.truncated = true;
      packed.hint = hint;
    }
    if (omittedCalls > 0) packed.omittedCalls = omittedCalls;
    const text = JSON.stringify(packed);
    return { text, details: packed, bytes: Buffer.byteLength(text, 'utf8') };
  };

  let out = build();
  if (out.bytes <= MAX_OUTPUT_BYTES) return { text: out.text, details: out.details };

  hint = `value too large (${rawValue.length} chars); write to a file or narrow the return`;
  let head = rawValue;
  value = `${head}…`;
  out = build();
  while (head.length > 0 && out.bytes > MAX_OUTPUT_BYTES) {
    head = head.slice(0, Math.max(0, Math.floor(head.length * 0.8)));
    value = `${head}…`;
    out = build();
  }
  if (out.bytes <= MAX_OUTPUT_BYTES) return { text: out.text, details: out.details };

  hint = 'output too large; write to a file or narrow the return';
  calls = slimCalls(calls);
  out = build();
  if (out.bytes <= MAX_OUTPUT_BYTES) return { text: out.text, details: out.details };

  while (calls.length > 0 && out.bytes > MAX_OUTPUT_BYTES) {
    const drop = Math.max(1, Math.ceil(calls.length * 0.2));
    omittedCalls += drop;
    calls = calls.slice(0, Math.max(0, calls.length - drop));
    out = build();
  }
  if (out.bytes <= MAX_OUTPUT_BYTES) return { text: out.text, details: out.details };

  value = '';
  error = error?.slice(0, 200);
  omittedCalls += calls.length;
  calls = [];
  out = build();
  return { text: out.text, details: out.details };
}

function failed(message: string, extra?: Record<string, unknown>) {
  const packed = packGuestOutput({
    status: 'failed',
    error: message,
    calls: Array.isArray(extra?.calls) ? extra.calls : [],
  });
  return {
    content: [{ type: 'text' as const, text: packed.text }],
    details: packed.details,
    isError: true as const,
  };
}

export function createIsolatedSandboxTool(options: IsolatedSandboxToolOptions): ToolDefinition {
  return {
    name: 'exec',
    label: 'Isolated sandbox',
    description:
      'If you are about to make 3+ similar read/grep/find calls and only need the aggregate, use exec instead of repeating those tools. ' +
      'Example:\n' +
      'const files = (await find({pattern:"src/**/*.ts"})).content.split("\\n").filter(Boolean);\n' +
      'const hits = await Promise.all(files.map(f => grep({pattern:"TODO", path:f})));\n' +
      'return hits.filter(h => h.content).length;\n' +
      'Each tool returns { content, details?, isError }. No console/fetch/setTimeout/URL/TextEncoder — use return. ' +
      'Tool failures resolve as { content, isError: true } and do not reject — check isError, do not rely on throw. ' +
      'A JavaScript exception still fails the whole cell. ' +
      'Hashline headers require the Hashline setting, same as top-level read. ' +
      'Tool names: "-" and "__" become "_": mcp__semble__search → mcp_semble_search. ' +
      'catalog.list() / listTools() lists callable names. store()/load() last for this live session. Not a shell.',
    promptSnippet:
      'exec: 3+ similar read/grep/find when you only need the aggregate — not for exploring. ' +
      'No console; return the value. Uncaught throw fails the cell. MCP names collapse __ and - to _.',
    promptGuidelines: [
      'If you are about to make 3+ similar read/grep/find calls and only need the aggregate, use exec instead.',
      'No console.log — there is no console, fetch, setTimeout, URL, TextEncoder, or structuredClone. Use return.',
      'Tool failures resolve with isError: true and do not throw. A JS exception still fails the whole cell.',
      'Each nested tool returns { content: string, details?: unknown, isError: boolean }. Do not treat the result as a raw string.',
      'Hashline [path#tag] headers require the Hashline setting, same as top-level read/grep.',
      'Tool names replace "-" and "__" with "_": mcp__semble__search → mcp_semble_search. Use catalog.list() or listTools() for names.',
      'store(key, value) / load(key) keep JSON across exec cells until this session unloads; they do not survive resume.',
      'exec is deterministic code with no LLM inside. Use subagent when each item needs judgment.',
    ],
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript source. Top-level await and return work.',
        },
        command: { type: 'string', description: 'Deprecated alias of code. Not a shell command.' },
      },
      additionalProperties: false,
    } as unknown as ToolDefinition['parameters'],
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const record = (params ?? {}) as Record<string, unknown>;
      const code = [record.code, record.command].find((value) => typeof value === 'string') as
        | string
        | undefined;
      if (!code?.trim()) throw new Error('exec requires code');
      if (looksLikeShellCommand(code)) {
        throw new Error('exec expects JavaScript, not a shell command. Use bash for shell.');
      }
      const catalog = options
        .getTools()
        .filter(
          (tool) => tool.name && !FORBIDDEN_GUEST_TOOLS.has(tool.name) && tool.name !== 'exec'
        );
      return runGuest({
        code,
        catalog,
        parentCallId: toolCallId,
        signal,
        ctx,
        store: options.store ?? new Map(),
      });
    },
  };
}

async function runGuest(input: {
  code: string;
  catalog: readonly ToolDefinition[];
  parentCallId: string;
  signal?: AbortSignal;
  ctx: unknown;
  store: Map<string, unknown>;
}) {
  const taken = new Set(RESERVED_CALLABLES);
  const aliases = input.catalog.map((tool) => ({
    callable: guestCallableName(tool.name, taken),
    tool: tool.name,
  }));
  const names = aliases.map((entry) => entry.callable);
  const listing = aliases.map((entry) => ({ name: entry.callable, tool: entry.tool }));
  const tools = new Map(input.catalog.map((tool) => [tool.name, tool]));
  const queue: HostCall[] = [];
  const calls: Array<{ name: string; ok: boolean; error?: string; summary?: string }> = [];
  let nextId = 0;
  let admitted = 0;
  const started = performance.now();
  let pausedMs = 0;
  let pauseStarted = 0;
  let hostInflight = 0;
  const elapsed = () =>
    performance.now() -
    started -
    pausedMs -
    (pauseStarted === 0 ? 0 : performance.now() - pauseStarted);

  const vm = await QuickJS.create({
    wasm: await loadQuickJsWasm(),
    memoryLimit: MEMORY_LIMIT_BYTES,
    interruptHandler: () => elapsed() > TIMEOUT_MS || Boolean(input.signal?.aborted),
  });

  const pause = () => {
    if (hostInflight++ === 0) pauseStarted = performance.now();
  };
  const resume = () => {
    if (hostInflight === 0) return;
    hostInflight -= 1;
    if (hostInflight > 0) return;
    if (pauseStarted === 0) return;
    pausedMs += performance.now() - pauseStarted;
    pauseStarted = 0;
  };

  try {
    vm.newFunction('__ensoEnqueue', (nameHandle: JSValueHandle, argsHandle: JSValueHandle) => {
      const name = nameHandle.toString();
      if (FORBIDDEN_GUEST_TOOLS.has(name) || name === 'exec') {
        throw new Error(`Tool "${name}" is not available in the isolated sandbox`);
      }
      if (!tools.has(name))
        throw new Error(`Tool "${name}" is not available in the isolated sandbox`);
      if (admitted >= MAX_TOOL_CALLS) throw new Error('isolated sandbox tool call budget exceeded');
      admitted += 1;
      let args: unknown = {};
      try {
        args = JSON.parse(argsHandle.toString()) as unknown;
      } catch {
        args = {};
      }
      const id = String(++nextId);
      queue.push({ id, name, args });
      return vm.newString(id);
    }).consume((handle) => vm.global.setProp('__ensoEnqueue', handle));
    vm.newFunction('__ensoStore', (keyHandle: JSValueHandle, jsonHandle: JSValueHandle) => {
      const key = keyHandle.toString();
      const raw = jsonHandle.toString();
      if (!raw) {
        input.store.delete(key);
        return vm.undefined;
      }
      try {
        input.store.set(key, jsonClone(JSON.parse(raw)));
      } catch {
        input.store.delete(key);
      }
      return vm.undefined;
    }).consume((handle) => vm.global.setProp('__ensoStore', handle));
    vm.newFunction('__ensoLoad', (keyHandle: JSValueHandle) => {
      const key = keyHandle.toString();
      if (!input.store.has(key)) return vm.undefined;
      const stored = input.store.get(key);
      if (stored === undefined) {
        input.store.delete(key);
        return vm.undefined;
      }
      return vm.newString(JSON.stringify(stored));
    }).consume((handle) => vm.global.setProp('__ensoLoad', handle));

    const prelude = `
      const __ensoWaiters = new Map();
      globalThis.__ensoSettle = (id, ok, json) => {
        const waiter = __ensoWaiters.get(id);
        if (!waiter) return;
        __ensoWaiters.delete(id);
        if (ok) waiter.resolve(JSON.parse(json));
        else waiter.reject(new Error(json));
      };
      function __ensoCall(name, args) {
        const id = __ensoEnqueue(name, JSON.stringify(args === undefined ? {} : args));
        return new Promise((resolve, reject) => {
          __ensoWaiters.set(id, { resolve, reject });
        });
      }
      for (const alias of ${JSON.stringify(aliases)}) {
        globalThis[alias.callable] = (args) => __ensoCall(alias.tool, args);
      }
      globalThis.store = (key, value) => {
        if (value === undefined) { __ensoStore(String(key), ''); return; }
        __ensoStore(String(key), JSON.stringify(value));
      };
      globalThis.load = (key) => {
        const raw = __ensoLoad(String(key));
        return raw === undefined ? undefined : JSON.parse(raw);
      };
      globalThis.catalog = {
        search(query, options) {
          const q = String(query ?? "").toLowerCase();
          const limit = options && options.limit > 0 ? options.limit : 20;
          return ${JSON.stringify(names)}
            .filter((name) => name.toLowerCase().includes(q))
            .slice(0, limit)
            .map((name) => globalThis[name]);
        },
        all() { return ${JSON.stringify(names)}.map((name) => globalThis[name]); },
        list() { return ${JSON.stringify(listing)}; },
      };
      globalThis.listTools = () => ${JSON.stringify(listing)};
      const __noConsole = () => { throw new Error('No console; use return for output'); };
      globalThis.console = { log: __noConsole, info: __noConsole, warn: __noConsole, error: __noConsole, debug: __noConsole };
    `;
    vm.evalCode(prelude, 'enso-sandbox:prelude.js').dispose();

    const resultHandle = vm.evalCode(`(async () => {\n${input.code}\n})()`, 'enso-sandbox.js');
    const done = vm.resolvePromise(resultHandle);
    let settled: Awaited<typeof done> | undefined;
    const finish = done.then((value) => {
      settled = value;
      return value;
    });

    const settleJob = (id: string, ok: boolean, payload: unknown) => {
      const settle = vm.global.getProp('__ensoSettle');
      const idHandle = vm.newString(id);
      const jsonHandle = vm.newString(JSON.stringify(payload));
      try {
        vm.callFunction(
          settle,
          vm.undefined,
          idHandle,
          ok ? vm.true : vm.false,
          jsonHandle
        ).dispose();
      } finally {
        settle.dispose();
        idHandle.dispose();
        jsonHandle.dispose();
      }
    };

    const runJob = async (job: HostCall) => {
      const tool = tools.get(job.name);
      const args =
        job.args && typeof job.args === 'object' && !Array.isArray(job.args) ? job.args : {};
      const summary = callSummary(args);
      let ok = true;
      let payload: unknown = {};
      let error: string | undefined;
      pause();
      try {
        if (!tool) throw new Error(`Tool "${job.name}" is not available in the isolated sandbox`);
        const nestedId = `${input.parentCallId}:${job.name}:${job.id}`;
        const result = await tool.execute(
          nestedId,
          args as Record<string, unknown>,
          input.signal,
          undefined,
          input.ctx as never
        );
        const isError = (result as { isError?: boolean }).isError === true;
        ok = !isError;
        payload = guestResult({ ...result, isError });
        if (isError) error = textOf(result) || 'tool error';
      } catch (caught) {
        ok = false;
        error = caught instanceof Error ? caught.message : String(caught);
        payload = { content: error, isError: true };
      } finally {
        resume();
      }
      calls.push(
        ok
          ? { name: job.name, ok, ...(summary ? { summary } : {}) }
          : { name: job.name, ok, error, ...(summary ? { summary } : {}) }
      );
      try {
        settleJob(job.id, true, payload);
        vm.executePendingJobs();
      } catch {
        /* vm already tearing down */
      }
    };

    const drain = async () => {
      const running = new Set<Promise<void>>();
      const launch = () => {
        if (settled) {
          dropQueued(queue, calls);
          return;
        }
        while (queue.length > 0 && running.size < MAX_INFLIGHT) {
          const job = queue.shift();
          if (!job) break;
          let task!: Promise<void>;
          task = runJob(job).finally(() => {
            running.delete(task);
          });
          running.add(task);
        }
      };
      launch();
      while (running.size > 0) {
        await Promise.race(running);
        launch();
      }
    };

    try {
      while (!settled) {
        if (input.signal?.aborted) return failed('isolated sandbox aborted', { calls });
        if (elapsed() > TIMEOUT_MS) return failed('isolated sandbox timeout exceeded', { calls });
        vm.executePendingJobs();
        await Promise.resolve();
        if (settled) {
          dropQueued(queue, calls);
          break;
        }
        if (queue.length > 0) await drain();
        else await Promise.race([finish, new Promise((resolve) => setImmediate(resolve))]);
      }

      if ('error' in settled) {
        const message =
          settled.error instanceof JSException
            ? `${settled.error.name}: ${settled.error.message}`
            : String(vm.dump(settled.error));
        settled.error.dispose();
        return failed(withDidYouMean(message, names), { calls });
      }
      const value = jsonClone(vm.dump(settled.value));
      settled.value.dispose();
      const packed = packGuestOutput({ status: 'completed', value, calls });
      return { content: [{ type: 'text' as const, text: packed.text }], details: packed.details };
    } finally {
      resultHandle.dispose();
      void finish.catch(() => {});
    }
  } catch (error) {
    const message =
      error instanceof JSException
        ? `${error.name}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return failed(message, { calls });
  } finally {
    vm.dispose();
  }
}
