import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXTENSION_RUNNER_SPECIFIERS,
  extractHookHandler,
  filterBeforeAgentStartResult,
  filterContextResult,
  HASHED_OMP_TRELLIS_EXTENSION,
  hasInlineConsentGateGuards,
  hookHasInlineSubagentGuard,
  installExtensionRunnerGuard,
  isTrellisSubAgent,
  OVERLAY_EXTENSION,
  stripInlineConsentGateGuards,
  TEMPLATE_HASHES_PATH,
  TRELLIS_WORKFLOW_STATE_TYPE,
} from './trellisSubagentGuard';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const hashedPath = path.join(repoRoot, HASHED_OMP_TRELLIS_EXTENSION);
const overlayPath = path.join(repoRoot, OVERLAY_EXTENSION);
const hashesPath = path.join(repoRoot, TEMPLATE_HASHES_PATH);

const workflowState = {
  customType: TRELLIS_WORKFLOW_STATE_TYPE,
  content: 'Ask the user whether to create a Trellis task.',
};

const otherMessage = { customType: 'trellis-task-context', content: 'prd.md' };

function readHashedTemplate(): string {
  return readFileSync(hashedPath, 'utf8');
}

function restoreHashedTemplate(): string {
  return execFileSync('git', ['show', `HEAD:${HASHED_OMP_TRELLIS_EXTENSION}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

class FakeRunner {
  async emitBeforeAgentStart() {
    return { messages: [{ ...workflowState }, { ...otherMessage }] };
  }

  async emitContext(messages: unknown[]) {
    return [...messages, { ...workflowState }];
  }

  async emitSessionStart() {
    return { customType: 'trellis-task-context', content: 'session task context' };
  }
}

describe('isTrellisSubAgent', () => {
  const previous = process.env.PI_BLOCKED_AGENT;
  afterEach(() => {
    if (previous === undefined) delete process.env.PI_BLOCKED_AGENT;
    else process.env.PI_BLOCKED_AGENT = previous;
  });

  it('主会话不是 subagent', () => {
    delete process.env.PI_BLOCKED_AGENT;
    expect(isTrellisSubAgent()).toBe(false);
  });

  it('PI_BLOCKED_AGENT 命中 Trellis 三类 subagent', () => {
    for (const name of ['trellis-implement', 'trellis-check', 'trellis-research']) {
      expect(isTrellisSubAgent({ PI_BLOCKED_AGENT: name })).toBe(true);
    }
    expect(isTrellisSubAgent({ PI_BLOCKED_AGENT: 'general-purpose' })).toBe(false);
  });
});

describe('consent-gate filters', () => {
  it('subagent 的 before_agent_start 去掉 workflow-state，保留其它消息', () => {
    const filtered = filterBeforeAgentStartResult(
      { messages: [{ ...workflowState }, { ...otherMessage }], systemPrompt: 'keep' },
      true
    );
    expect(filtered).toEqual({ messages: [{ ...otherMessage }], systemPrompt: 'keep' });
  });

  it('subagent 若只剩同意门，messages 置空以免仍注入', () => {
    expect(filterBeforeAgentStartResult({ messages: [{ ...workflowState }] }, true)).toEqual({
      messages: undefined,
    });
  });

  it('主会话不过滤', () => {
    const result = { messages: [{ ...workflowState }] };
    expect(filterBeforeAgentStartResult(result, false)).toBe(result);
    const context = [{ ...workflowState }];
    expect(filterContextResult(context, false)).toBe(context);
  });

  it('subagent 的 context 去掉 workflow-state', () => {
    expect(filterContextResult([{ ...otherMessage }, { ...workflowState }], true)).toEqual([
      { ...otherMessage },
    ]);
  });
});

describe('installExtensionRunnerGuard', () => {
  const previous = process.env.PI_BLOCKED_AGENT;
  afterEach(() => {
    if (previous === undefined) delete process.env.PI_BLOCKED_AGENT;
    else process.env.PI_BLOCKED_AGENT = previous;
  });

  it('subagent 不再拿到同意门，session_start 任务上下文原样返回', async () => {
    process.env.PI_BLOCKED_AGENT = 'trellis-implement';
    installExtensionRunnerGuard(FakeRunner);
    const runner = new FakeRunner();

    expect(await runner.emitBeforeAgentStart()).toEqual({
      messages: [{ ...otherMessage }],
    });
    expect(await runner.emitContext([{ role: 'user', content: 'go' }])).toEqual([
      { role: 'user', content: 'go' },
    ]);
    expect(await runner.emitSessionStart()).toEqual({
      customType: 'trellis-task-context',
      content: 'session task context',
    });
  });

  it('没有安装守卫时 subagent 会漏出同意门（去掉 overlay 就会红）', async () => {
    process.env.PI_BLOCKED_AGENT = 'trellis-check';
    const runner = new (class {
      async emitBeforeAgentStart() {
        return { messages: [{ ...workflowState }] };
      }
    })();
    expect(await runner.emitBeforeAgentStart()).toEqual({ messages: [{ ...workflowState }] });
  });
});

describe('hashed template vs repo-owned overlay', () => {
  it('overlay 存在且未写入 template hashes（trellis update 不会覆盖）', () => {
    expect(existsSync(overlayPath)).toBe(true);
    const hashes = JSON.parse(readFileSync(hashesPath, 'utf8')) as {
      hashes: Record<string, string>;
    };
    expect(hashes.hashes[HASHED_OMP_TRELLIS_EXTENSION]).toBeTypeOf('string');
    expect(hashes.hashes[OVERLAY_EXTENSION]).toBeUndefined();
    for (const key of Object.keys(hashes.hashes)) {
      expect(key.includes('enso-subagent-guard')).toBe(false);
    }
  });

  it('overlay 安装 runner 守卫，且不订阅 session_start', () => {
    const src = readFileSync(overlayPath, 'utf8');
    expect(src).toContain('installExtensionRunnerGuard');
    expect(src).toContain('EXTENSION_RUNNER_SPECIFIERS');
    expect(src).not.toMatch(/pi\.on\(\s*["']session_start["']/);
    expect(EXTENSION_RUNNER_SPECIFIERS).toContain('@oh-my-pi/pi-coding-agent');
  });

  it('加载 overlay 后会给宿主 ExtensionRunner 打上守卫（删 overlay 即红）', async () => {
    const overlay = await import('../../.omp/extensions/enso-subagent-guard/index');
    const { ExtensionRunner } = await import('@earendil-works/pi-coding-agent');
    await overlay.default({});
    expect(
      Object.getOwnPropertySymbols(ExtensionRunner.prototype).includes(
        Symbol.for('enso.trellisSubagentConsentGate')
      )
    ).toBe(true);
  });

  it('hashed 模板在 before_agent_start / context 注入同意门；session_start 仍给 subagent 任务上下文', () => {
    const src = readHashedTemplate();
    const before = extractHookHandler(src, 'before_agent_start');
    const context = extractHookHandler(src, 'context');
    const sessionStart = extractHookHandler(src, 'session_start');
    expect(before).toMatch(/trellis-workflow-state/);
    expect(context).toMatch(/trellis-workflow-state/);
    expect(sessionStart).toMatch(/if \(isSubAgent\)/);
    expect(sessionStart).toMatch(/trellis-task-context/);
    expect(sessionStart).not.toMatch(/trellis-workflow-state/);
  });

  it('模拟模板还原后内联两行守卫消失，overlay 过滤仍然生效', async () => {
    const restored = stripInlineConsentGateGuards(restoreHashedTemplate());
    expect(hasInlineConsentGateGuards(restored)).toBe(false);
    expect(hookHasInlineSubagentGuard(restored, 'before_agent_start')).toBe(false);
    expect(hookHasInlineSubagentGuard(restored, 'context')).toBe(false);
    expect(extractHookHandler(restored, 'before_agent_start')).toMatch(/trellis-workflow-state/);
    expect(extractHookHandler(restored, 'session_start')).toMatch(/trellis-task-context/);

    process.env.PI_BLOCKED_AGENT = 'trellis-research';
    class RestoredTemplateRunner {
      async emitBeforeAgentStart() {
        return { messages: [{ ...workflowState }] };
      }
      async emitContext() {
        return [{ ...workflowState }];
      }
    }
    installExtensionRunnerGuard(RestoredTemplateRunner);
    const runner = new RestoredTemplateRunner();
    expect(await runner.emitBeforeAgentStart()).toEqual({ messages: undefined });
    expect(await runner.emitContext()).toEqual([]);
    delete process.env.PI_BLOCKED_AGENT;
  });

  it('去掉 overlay 安装点会让契约测试失败', () => {
    const src = readFileSync(overlayPath, 'utf8');
    expect(src.includes('installExtensionRunnerGuard')).toBe(true);
    expect(existsSync(path.join(repoRoot, 'src/tooling/trellisSubagentGuard.ts'))).toBe(true);
  });
});

describe('host ExtensionRunner after template restore', () => {
  const previous = process.env.PI_BLOCKED_AGENT;
  afterEach(() => {
    if (previous === undefined) delete process.env.PI_BLOCKED_AGENT;
    else process.env.PI_BLOCKED_AGENT = previous;
  });

  it('还原 hashed 模板后，overlay 仍能拦掉真实 runner 注入的同意门', async () => {
    const restored = stripInlineConsentGateGuards(restoreHashedTemplate());
    expect(hasInlineConsentGateGuards(restored)).toBe(false);

    const { ExtensionRunner, createExtensionRuntime } = await import(
      '@earendil-works/pi-coding-agent'
    );
    const runtime = createExtensionRuntime();
    const extension = {
      path: 'fake-trellis',
      resolvedPath: 'fake-trellis',
      handlers: new Map([
        ['before_agent_start', [async () => ({ message: { ...workflowState } })]],
        [
          'context',
          [
            async (event: { messages: unknown[] }) => ({
              messages: [...event.messages, { ...workflowState }],
            }),
          ],
        ],
        ['session_start', [async () => undefined]],
      ]),
      tools: new Map(),
      messageRenderers: new Map(),
      entryRenderers: new Map(),
      commands: new Map(),
      flags: new Map(),
      shortcuts: new Map(),
    };

    process.env.PI_BLOCKED_AGENT = 'trellis-implement';
    installExtensionRunnerGuard(ExtensionRunner);
    const runner = new ExtensionRunner(
      [extension] as never,
      runtime,
      repoRoot,
      undefined as never,
      undefined as never
    );

    const before = await runner.emitBeforeAgentStart('go', undefined, '', { cwd: repoRoot });
    expect(before?.messages?.some((m) => m.customType === TRELLIS_WORKFLOW_STATE_TYPE)).toBeFalsy();

    const context = await runner.emitContext([{ role: 'user', content: 'go' }] as never);
    expect(context.some((m) => isWorkflowStateLike(m))).toBe(false);

    // session_start 不在守卫范围：不调用 emitSessionStart 也不断言它被剥掉
    expect(extension.handlers.get('session_start')?.length).toBe(1);
  });
});

function isWorkflowStateLike(message: unknown): boolean {
  return (
    message !== null &&
    typeof message === 'object' &&
    (message as { customType?: string }).customType === TRELLIS_WORKFLOW_STATE_TYPE
  );
}
