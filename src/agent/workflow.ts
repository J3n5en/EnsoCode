import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentControlToolRequest, AgentControlToolResponse } from '@shared/types/agent';
import type { WorkflowMemberSnapshot, WorkflowRunSnapshot } from '@shared/types/workflow';
import { JSException, type JSValueHandle, QuickJS } from 'quickjs-wasi';

const require = createRequire(import.meta.url);
let wasmModule: Promise<WebAssembly.Module> | undefined;

function loadQuickJsWasm(): Promise<WebAssembly.Module> {
  wasmModule ??= readFile(require.resolve('quickjs-wasi/quickjs.wasm')).then((bytes) =>
    WebAssembly.compile(bytes)
  );
  return wasmModule;
}

const MAX_AGENTS = 32;
const MAX_INFLIGHT = 4;
const TIMEOUT_MS = 10 * 60 * 1000;
const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const LOG_LIMIT = 20;

export interface WorkflowToolDeps {
  invoke(request: AgentControlToolRequest, signal?: AbortSignal): Promise<AgentControlToolResponse>;
  emit(run: WorkflowRunSnapshot): void;
  randomUuid?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function childIdOf(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.agentId !== 'string') return undefined;
  const id = value.agentId.trim();
  return id && id.length <= 80 ? id : undefined;
}

function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length > max ? text.slice(0, max) : text;
}

export function workflowChildOutcome(
  spawnValue: unknown,
  reportValue: unknown
): { failed: boolean; text: string | null } {
  if (!isRecord(spawnValue) || !isRecord(spawnValue.report)) return { failed: true, text: null };
  const receipt = spawnValue.report;
  if (receipt.timedOut === true || receipt.interrupted === true)
    return { failed: true, text: null };
  const run = Array.isArray(receipt.runs) ? receipt.runs[0] : undefined;
  if (!isRecord(run) || run.status !== 'succeeded') return { failed: true, text: null };
  if (!isRecord(reportValue)) return { failed: false, text: '' };
  if (reportValue.value !== undefined) {
    return { failed: false, text: JSON.stringify(reportValue.value) };
  }
  return {
    failed: false,
    text: typeof reportValue.text === 'string' ? reportValue.text : '',
  };
}

function parseMeta(value: unknown): { name: string; description: string } | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === 'string' ? clip(value.name, 80) : '';
  const description = typeof value.description === 'string' ? clip(value.description, 240) : '';
  if (!name || !description) return null;
  return { name, description };
}

interface HostJob {
  id: string;
  op: 'agent' | 'phase' | 'log';
  payload: Record<string, unknown>;
}

class WorkflowRunState {
  readonly snapshot: WorkflowRunSnapshot;
  agentsStarted = 0;
  private memberSeq = 0;
  private batchSeq = 0;

  constructor(runId: string, meta: { name: string; description: string }) {
    this.snapshot = {
      runId,
      name: meta.name,
      description: meta.description,
      status: 'running',
      logs: [],
      members: [],
    };
  }

  phase(title: string): void {
    this.snapshot.phase = clip(title, 80);
  }

  nextBatch(): number {
    return ++this.batchSeq;
  }

  log(message: string): void {
    const line = clip(message, 160);
    if (!line) return;
    this.snapshot.logs = [...this.snapshot.logs, line].slice(-LOG_LIMIT);
  }

  startMember(
    label: string,
    phase: string | undefined,
    batch: number,
    prompt: string
  ): WorkflowMemberSnapshot {
    const member: WorkflowMemberSnapshot = {
      seq: ++this.memberSeq,
      label: clip(label, 80) || 'agent',
      batch,
      status: 'running',
    };
    const memberPhase = phase ? clip(phase, 80) : '';
    if (memberPhase) member.phase = memberPhase;
    const task = clip(prompt, 160);
    if (task) member.prompt = task;
    this.snapshot.members = [...this.snapshot.members, member];
    return member;
  }

  finishMember(
    seq: number,
    status: 'completed' | 'failed',
    detail: { result?: string; childId?: string } = {}
  ): void {
    const result = detail.result ? clip(detail.result, 160) : '';
    const childId = detail.childId ? clip(detail.childId, 80) : '';
    this.snapshot.members = this.snapshot.members.map((member) =>
      member.seq === seq
        ? {
            ...member,
            status,
            ...(result ? { result } : {}),
            ...(childId ? { childId } : {}),
          }
        : member
    );
  }

  finish(status: WorkflowRunSnapshot['status'], error?: string): void {
    this.snapshot.status = status;
    if (error) this.snapshot.error = clip(error, 400);
    if (status !== 'completed') {
      this.snapshot.members = this.snapshot.members.map((member) =>
        member.status === 'running' ? { ...member, status: 'failed' } : member
      );
    }
  }

  copy(): WorkflowRunSnapshot {
    return {
      ...this.snapshot,
      logs: [...this.snapshot.logs],
      members: this.snapshot.members.map((member) => ({ ...member })),
    };
  }
}

async function runAgent(
  deps: WorkflowToolDeps,
  state: WorkflowRunState,
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
  publish: () => void
): Promise<{ fatal?: string; value: string | null }> {
  if (state.agentsStarted >= MAX_AGENTS) {
    return { fatal: `workflow agent cap exceeded (${MAX_AGENTS})`, value: null };
  }
  state.agentsStarted += 1;
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) return { fatal: 'agent() requires a non-empty prompt', value: null };
  const label =
    (typeof payload.label === 'string' && payload.label.trim()) ||
    prompt
      .split('\n')
      .find((line) => line.trim())
      ?.trim()
      .slice(0, 80) ||
    'agent';
  const explicitPhase = typeof payload.phase === 'string' ? payload.phase : undefined;
  const batch =
    typeof payload.batch === 'number' && payload.batch > 0 ? payload.batch : state.nextBatch();
  const member = state.startMember(label, explicitPhase || state.snapshot.phase, batch, prompt);
  publish();
  const model = typeof payload.model === 'string' ? payload.model : undefined;
  const agentType = typeof payload.agentType === 'string' ? payload.agentType : undefined;
  const schema = isRecord(payload.schema) ? payload.schema : undefined;
  try {
    const spawned = await deps.invoke(
      {
        operation: 'spawn',
        mode: 'task',
        description: member.label,
        prompt,
        wait: true,
        ...(model ? { model } : {}),
        ...(agentType ? { agentType } : {}),
        ...(schema ? { schema } : {}),
      },
      signal
    );
    if (!spawned.ok) {
      state.finishMember(member.seq, 'failed');
      publish();
      return { fatal: spawned.error, value: null };
    }
    const childId = childIdOf(spawned.value);
    const runId =
      isRecord(spawned.value) && typeof spawned.value.runId === 'string' ? spawned.value.runId : '';
    const reported = runId
      ? await deps.invoke({ operation: 'report', runId }, signal)
      : { ok: false as const, code: 'invalid-state' as const, error: 'missing run id' };
    const outcome = workflowChildOutcome(spawned.value, reported.ok ? reported.value : undefined);
    state.finishMember(member.seq, outcome.failed ? 'failed' : 'completed', {
      ...(childId ? { childId } : {}),
      ...(outcome.text ? { result: outcome.text } : {}),
    });
    publish();
    if (!reported.ok && outcome.failed) return { fatal: reported.error, value: null };
    return { value: outcome.failed ? null : outcome.text };
  } catch (error) {
    state.finishMember(member.seq, 'failed');
    publish();
    if (signal?.aborted) return { fatal: 'workflow cancelled', value: null };
    return {
      fatal: error instanceof Error ? error.message : String(error),
      value: null,
    };
  }
}

async function runScript(
  deps: WorkflowToolDeps,
  state: WorkflowRunState,
  script: string,
  args: unknown,
  signal: AbortSignal | undefined
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const publish = () => deps.emit(state.copy());
  publish();
  const queue: HostJob[] = [];
  let nextId = 0;
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
    interruptHandler: () => elapsed() > TIMEOUT_MS || Boolean(signal?.aborted),
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
    vm.newFunction('__enqueue', (opHandle: JSValueHandle, jsonHandle: JSValueHandle) => {
      const op = opHandle.toString();
      if (op !== 'agent' && op !== 'phase' && op !== 'log') {
        throw new Error(`unsupported workflow hook: ${op}`);
      }
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(jsonHandle.toString()) as unknown;
        if (isRecord(parsed)) payload = parsed;
      } catch {
        payload = {};
      }
      const id = String(++nextId);
      queue.push({ id, op, payload });
      return vm.newString(id);
    }).consume((handle) => vm.global.setProp('__enqueue', handle));
    const prelude = `
      const __waiters = new Map();
      globalThis.__settle = (id, ok, json) => {
        const waiter = __waiters.get(id);
        if (!waiter) return;
        __waiters.delete(id);
        if (ok) waiter.resolve(JSON.parse(json));
        else {
          const error = new Error(json);
          error.fatal = true;
          waiter.reject(error);
        }
      };
      function __call(op, payload) {
        const id = __enqueue(op, JSON.stringify(payload === undefined ? {} : payload));
        return new Promise((resolve, reject) => __waiters.set(id, { resolve, reject }));
      }
      function fatal(message) {
        const error = new Error(message);
        error.fatal = true;
        throw error;
      }
      globalThis.agent = async (prompt, opts) => {
        if (typeof prompt !== 'string' || !prompt.trim()) fatal('agent() requires a non-empty prompt');
        const options = opts === undefined ? {} : opts;
        if (!options || typeof options !== 'object' || Array.isArray(options)) fatal('agent() options must be an object');
        for (const key of Object.keys(options)) {
          if (!['label', 'phase', 'model', 'agentType', 'schema'].includes(key)) {
            fatal('agent() option "' + key + '" is not supported');
          }
        }
        const result = await __call('agent', { prompt, ...options });
        return result ? result.value : null;
      };
      globalThis.phase = (title) => {
        if (typeof title !== 'string' || !title.trim()) fatal('phase() requires a title');
        return __call('phase', { title });
      };
      globalThis.log = (message) => {
        if (typeof message !== 'string') fatal('log() requires a string');
        return __call('log', { message });
      };
      globalThis.parallel = async (thunks) => {
        if (!Array.isArray(thunks)) fatal('parallel() requires an array of functions');
        return Promise.all(thunks.map(async (fn, index) => {
          if (typeof fn !== 'function') fatal('parallel() item ' + index + ' is not a function');
          try { return await fn(); }
          catch (error) { if (error && error.fatal) throw error; return null; }
        }));
      };
      globalThis.pipeline = async (items, ...stages) => {
        if (!Array.isArray(items)) fatal('pipeline() requires an items array');
        if (stages.length === 0 || stages.some((stage) => typeof stage !== 'function')) {
          fatal('pipeline() requires function stages');
        }
        return Promise.all(items.map(async (item, index) => {
          let prev;
          for (const stage of stages) {
            try { prev = await stage(prev, item, index); }
            catch (error) { if (error && error.fatal) throw error; return null; }
          }
          return prev;
        }));
      };
      globalThis.args = ${JSON.stringify(args ?? {})};
    `;
    vm.evalCode(prelude, 'enso-workflow:prelude.js').dispose();
    const resultHandle = vm.evalCode(`(async () => {\n${script}\n})()`, 'enso-workflow.js');
    const done = vm.resolvePromise(resultHandle);
    let settled: Awaited<typeof done> | undefined;
    const finish = done.then((value) => {
      settled = value;
      return value;
    });
    const settleJob = (id: string, ok: boolean, payload: unknown) => {
      const settle = vm.global.getProp('__settle');
      const idHandle = vm.newString(id);
      const jsonHandle = vm.newString(ok ? JSON.stringify(payload) : String(payload));
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
    const runJob = async (job: HostJob) => {
      pause();
      try {
        if (job.op === 'phase') {
          state.phase(String(job.payload.title ?? ''));
          publish();
          settleJob(job.id, true, {});
        } else if (job.op === 'log') {
          state.log(String(job.payload.message ?? ''));
          publish();
          settleJob(job.id, true, {});
        } else {
          const result = await runAgent(deps, state, job.payload, signal, publish);
          if (result.fatal) settleJob(job.id, false, result.fatal);
          else settleJob(job.id, true, { value: result.value });
        }
        vm.executePendingJobs();
      } catch {
        /* vm already tearing down */
      } finally {
        resume();
      }
    };
    const drain = async () => {
      const wave = queue.splice(0);
      const setup = wave.filter((job) => job.op !== 'agent');
      const agents = wave.filter((job) => job.op === 'agent');
      for (const job of setup) await runJob(job);
      const batch = agents.length > 0 ? state.nextBatch() : undefined;
      const running = new Set<Promise<void>>();
      let index = 0;
      const launch = () => {
        while (index < agents.length && running.size < MAX_INFLIGHT) {
          const job = agents[index++];
          if (!job) break;
          if (batch !== undefined) job.payload = { ...job.payload, batch };
          let task!: Promise<void>;
          task = runJob(job).finally(() => running.delete(task));
          running.add(task);
        }
      };
      launch();
      while (running.size > 0) {
        await Promise.race(running);
        launch();
      }
    };
    while (!settled) {
      if (signal?.aborted) return { ok: false, error: 'workflow cancelled' };
      if (elapsed() > TIMEOUT_MS) return { ok: false, error: 'workflow timeout exceeded' };
      vm.executePendingJobs();
      await Promise.resolve();
      if (settled) break;
      if (queue.length > 0) await drain();
      else await Promise.race([finish, new Promise((resolve) => setImmediate(resolve))]);
    }
    if (!settled) return { ok: false, error: 'workflow did not settle' };
    if ('error' in settled) {
      const message =
        settled.error instanceof JSException
          ? settled.error.message || settled.error.name
          : String(vm.dump(settled.error));
      settled.error.dispose();
      return { ok: false, error: message || 'workflow failed' };
    }
    const value = vm.dump(settled.value);
    settled.value.dispose();
    return { ok: true, value };
  } finally {
    vm.dispose();
  }
}

export function createWorkflowTool(deps: WorkflowToolDeps): ToolDefinition {
  return {
    name: 'workflow',
    label: 'Workflow',
    description:
      'Run a JavaScript workflow that fans work out across subagents. Use only when the user asks for a workflow or a large multi-agent fan-out. ' +
      'The script is plain JavaScript with top-level await and must return a JSON value. Hooks: agent(prompt, opts?), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), args. ' +
      'A failed child resolves to null. Bad hook arguments fail the whole run. The script cannot use filesystem, network, timers, or Node APIs. Status is shown in the side panel.',
    promptSnippet:
      'workflow: write a JavaScript orchestration script that fans subagents out. Use only for an explicit workflow request or a large fan-out. One or two delegations should use subagent.',
    promptGuidelines: [
      'Use workflow only when the user asks for a workflow or for large multi-agent orchestration.',
      'script is plain JavaScript, not TypeScript, with top-level await. End with return <json>.',
      'agent() options are only label, phase, model, agentType, and schema. Anything else fails the run.',
      'Child failure returns null. Do not treat null as success without checking it.',
    ],
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['script', 'meta'],
      properties: {
        script: {
          type: 'string',
          description:
            'Plain JavaScript body. Top-level await is allowed. End with return <json-value>.',
        },
        meta: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'description'],
          description: 'Workflow identity. Plain JSON, never code.',
          properties: {
            name: { type: 'string', description: 'Short kebab-case workflow name.' },
            description: { type: 'string', description: 'One-line description of the workflow.' },
          },
        },
        args: {
          type: 'object',
          additionalProperties: true,
          description: 'Optional JSON object exposed to the script as the args global.',
        },
      },
    } as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params, signal) {
      const record = (params ?? {}) as Record<string, unknown>;
      const script = typeof record.script === 'string' ? record.script : '';
      const meta = parseMeta(record.meta);
      if (!script.trim() || !meta)
        throw new Error('workflow requires script, meta.name, and meta.description');
      if (record.args !== undefined && !isRecord(record.args)) {
        throw new Error('workflow args must be a JSON object');
      }
      const state = new WorkflowRunState(deps.randomUuid?.() ?? crypto.randomUUID(), meta);
      let result: Awaited<ReturnType<typeof runScript>>;
      try {
        result = await runScript(deps, state, script, record.args ?? {}, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.finish(signal?.aborted ? 'cancelled' : 'failed', message);
        deps.emit(state.copy());
        throw error;
      }
      if (!result.ok) {
        state.finish(
          signal?.aborted || result.error === 'workflow cancelled' ? 'cancelled' : 'failed',
          result.error
        );
        deps.emit(state.copy());
        return {
          content: [{ type: 'text', text: result.error }],
          details: { runId: state.snapshot.runId, agentsStarted: state.agentsStarted },
          isError: true,
        };
      }
      state.finish('completed');
      deps.emit(state.copy());
      const text = `workflow "${meta.name}" completed (${state.agentsStarted} agents).\nReturn value:\n${JSON.stringify(result.value, null, 2)}`;
      return {
        content: [{ type: 'text', text }],
        details: {
          runId: state.snapshot.runId,
          agentsStarted: state.agentsStarted,
          result: result.value,
        },
      };
    },
  };
}
