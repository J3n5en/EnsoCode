import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXTENSION_RUNNER_SPECIFIERS,
  filterBeforeAgentStartResult,
  filterContextResult,
  installExtensionRunnerGuard,
  isTrellisSubAgent,
  RUNNER_GUARD_INSTALLED,
  TRELLIS_WORKFLOW_STATE_TYPE,
} from '../../.omp/extensions/enso-subagent-guard/guard';

const HASHED_OMP_TRELLIS_EXTENSION = '.omp/extensions/trellis/index.ts';
const OVERLAY_DIR = '.omp/extensions/enso-subagent-guard';
const OVERLAY_ENTRY = `${OVERLAY_DIR}/index.ts`;
const OVERLAY_GUARD = `${OVERLAY_DIR}/guard.ts`;
const TEMPLATE_HASHES_PATH = '.trellis/.template-hashes.json';
const INLINE_GUARD_RE = /if\s*\(\s*isSubAgent\s*\)\s*return\s*;/;

const repoRoot = path.resolve(import.meta.dirname, '../..');
const hashedPath = path.join(repoRoot, HASHED_OMP_TRELLIS_EXTENSION);
const overlayPath = path.join(repoRoot, OVERLAY_ENTRY);
const overlayGuardPath = path.join(repoRoot, OVERLAY_GUARD);
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

function extractHookHandler(source: string, hook: string): string | null {
  const startRe = new RegExp(String.raw`pi\.on\(\s*["']${hook}["']`);
  const startMatch = startRe.exec(source);
  if (!startMatch) return null;
  const brace = source.indexOf('{', startMatch.index);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(brace + 1, i);
    }
  }
  return null;
}

function hookHasInlineSubagentGuard(source: string, hook: string): boolean {
  const body = extractHookHandler(source, hook);
  return body !== null && INLINE_GUARD_RE.test(body);
}

function hasInlineConsentGateGuards(source: string): boolean {
  return (
    hookHasInlineSubagentGuard(source, 'before_agent_start') &&
    hookHasInlineSubagentGuard(source, 'context')
  );
}

/** Simulate `trellis update` restoring the hashed template (drops the two-line patch). */
function stripInlineConsentGateGuards(source: string): string {
  let next = source;
  for (const hook of ['before_agent_start', 'context'] as const) {
    const body = extractHookHandler(next, hook);
    if (!body) continue;
    const stripped = body
      .replace(/\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*if\s*\(\s*isSubAgent\s*\)\s*return\s*;\s*/g, '')
      .replace(/if\s*\(\s*isSubAgent\s*\)\s*return\s*;\s*/g, '');
    next = next.replace(body, stripped);
  }
  return next;
}

function isWorkflowStateLike(message: unknown): boolean {
  return (
    message !== null &&
    typeof message === 'object' &&
    (message as { customType?: string }).customType === TRELLIS_WORKFLOW_STATE_TYPE
  );
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
    expect(existsSync(overlayGuardPath)).toBe(true);
    const hashes = JSON.parse(readFileSync(hashesPath, 'utf8')) as {
      hashes: Record<string, string>;
    };
    expect(hashes.hashes[HASHED_OMP_TRELLIS_EXTENSION]).toBeTypeOf('string');
    expect(hashes.hashes[OVERLAY_ENTRY]).toBeUndefined();
    expect(hashes.hashes[OVERLAY_GUARD]).toBeUndefined();
    for (const key of Object.keys(hashes.hashes)) {
      expect(key.includes('enso-subagent-guard')).toBe(false);
    }
  });

  it('overlay 自包含：不从 src/ 取实现，且不订阅 session_start', () => {
    const entry = readFileSync(overlayPath, 'utf8');
    const guard = readFileSync(overlayGuardPath, 'utf8');
    expect(entry).toMatch(/from\s+["']\.\/guard["']/);
    expect(entry).toContain('installHostExtensionRunnerGuard');
    expect(entry).not.toMatch(/from\s+["'][^"']*src\//);
    expect(guard).not.toMatch(/from\s+["'][^"']*src\//);
    expect(entry).not.toMatch(/pi\.on\(\s*["']session_start["']/);
    expect(guard).not.toMatch(/pi\.on\(\s*["']session_start["']/);
    expect(EXTENSION_RUNNER_SPECIFIERS).toContain('@oh-my-pi/pi-coding-agent');
    expect(existsSync(path.join(repoRoot, 'src/tooling/trellisSubagentGuard.ts'))).toBe(false);
  });

  it('加载 overlay 后会给宿主 ExtensionRunner 打上守卫（删 overlay 即红）', async () => {
    const overlay = await import('../../.omp/extensions/enso-subagent-guard/index');
    const { ExtensionRunner } = await import('@earendil-works/pi-coding-agent');
    await overlay.default({});
    expect(
      Object.getOwnPropertySymbols(ExtensionRunner.prototype).includes(RUNNER_GUARD_INSTALLED)
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
    expect(src.includes('installHostExtensionRunnerGuard')).toBe(true);
    expect(existsSync(overlayGuardPath)).toBe(true);
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

    expect(extension.handlers.get('session_start')?.length).toBe(1);
  });
});
