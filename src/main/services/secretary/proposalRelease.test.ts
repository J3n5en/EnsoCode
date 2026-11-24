import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SessionStatusPayload } from '@shared/extensionPlugins/events';
import { parseProfile } from '@shared/secretary/parse';
import type {
  ConversationAuthority,
  ProjectAuthority,
  RendererAgentEvent,
} from '@shared/types/agent';
import type { SecretaryDispatchFile, SecretaryProposal } from '@shared/types/secretary';
import { afterEach, describe, expect, it } from 'vitest';
import { createSecretaryTools } from './customTools';
import { createSecretaryHost } from './host';
import { createSecretaryProfile } from './profile';
import { proposalUpdate } from './results';
import { createSecretarySkills } from './skills';

const idle = { state: 'idle' as const, pendingAsks: 0, pendingApprovals: 0 };
const running = { state: 'running' as const, pendingAsks: 0, pendingApprovals: 0 };
const identity = { sessionId: 'sec1', generation: 'g' };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 回传宿主与档案服务共用同一份 dispatch.json，事件按 Main 的顺序先给宿主、再给档案服务 */
function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), 'proposal-release-'));
  dirs.push(dir);
  const state = {
    file: {
      version: 1,
      dispatched: {},
      named: [],
      proposals: {},
      outbox: [],
    } as SecretaryDispatchFile,
    status: running as typeof idle | typeof running,
    prompts: [] as { text: string; deliveryId: string }[],
    released: [] as string[],
  };
  const base = parseProfile({});
  if (!base) throw new Error('default profile');
  const file = () => structuredClone(state.file);
  const save = (next: SecretaryDispatchFile) => {
    state.file = structuredClone(next);
  };
  const host = createSecretaryHost({
    enabled: () => true,
    file,
    save,
    rows: () => ({ sec1: { id: 'sec1', title: '秘书', projectId: 'sec' } }),
    conversations: () =>
      [
        { conversationId: 'sec1', projectId: 'sec', kind: 'root', version: 1 },
      ] as unknown as ConversationAuthority[],
    projects: () =>
      [
        { projectId: 'sec', canonicalPath: dir, state: 'active', kind: 'secretary' },
      ] as ProjectAuthority[],
    secretaryProjectId: () => 'sec',
    status: () => state.status,
    alive: () => !state.released.includes('sec1'),
    prompt: (_id, text, deliveryId) => {
      state.prompts.push({ text, deliveryId });
      return { ok: true };
    },
    resume: async () => ({ ok: true }),
    newId: () => `d${state.prompts.length + 1}`,
    profile: () => base,
    todos: () => [],
    saveTodos: () => undefined,
    schedules: () => [],
    saveSchedules: () => undefined,
    notify: () => undefined,
    publish: () => undefined,
    now: () => 1_000,
  });
  const profile = createSecretaryProfile({
    profile: () => base,
    saveProfile: (next) => next,
    persona: () => '',
    writePersona: () => undefined,
    clearFiles: () => undefined,
    clearPrivateMemory: async () => undefined,
    todos: () => [],
    schedules: () => [],
    saveSchedules: () => undefined,
    publish: () => undefined,
    conversations: async () => [{ conversationId: 'sec1' }],
    status: () => state.status,
    alive: () => !state.released.includes('sec1'),
    release: async (conversationId) => {
      state.released.push(conversationId);
      return { ok: true };
    },
    refreshPrompt: () => undefined,
    dispatchFile: file,
    saveDispatch: save,
    audit: () => undefined,
    notify: () => undefined,
    now: () => 1_000,
    newId: () => 'p1',
  });
  const kitPorts = {
    dir: () => dir,
    dispatchFile: file,
    saveDispatch: save,
    audit: () => undefined,
    notify: () => undefined,
    releaseSessions: () => profile.releaseSessions(),
    now: () => 1_000,
    newId: () => 'p1',
  };
  const tools = createSecretaryTools({
    ...kitPorts,
    runTool: async () => ({ ok: true, output: '' }),
  });
  const skills = createSecretarySkills(kitPorts);

  function emit(event: Record<string, unknown>, changes: SessionStatusPayload[] = []): void {
    const agentEvent = { identity, seq: 1, ...event } as unknown as RendererAgentEvent;
    host.onAgentEvent(agentEvent, changes);
    if (event.type === 'turn-completed' || event.type === 'turn-failed')
      void profile.onTurnEnded('sec1');
  }

  /** worker 收口一轮：先报空闲，再发 turn-completed */
  async function finishTurn(turnId: string): Promise<void> {
    state.status = idle;
    emit({ type: 'status', status: 'idle' }, [
      {
        sessionId: 'sec1',
        state: 'idle',
        previous: 'running',
        pendingAsks: 0,
        pendingApprovals: 0,
      },
    ]);
    await Promise.resolve();
    emit({ type: 'turn-completed', turnId });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** 宿主投出的这一批 user 消息上屏：worker 回执 delivery-settled，会话跑起来 */
  function deliveryStarted(): void {
    const deliveryId = state.prompts.at(-1)?.deliveryId;
    state.status = running;
    emit({ type: 'delivery-settled', deliveryId }, [
      {
        sessionId: 'sec1',
        state: 'running',
        previous: 'idle',
        pendingAsks: 0,
        pendingApprovals: 0,
      },
    ]);
  }

  return { state, profile, tools, skills, finishTurn, deliveryStarted };
}

const toolDraft = {
  name: 'release-card',
  description: '生成发版卡片',
  runtime: 'node',
  parameters: { type: 'object', properties: {} },
  readOnly: true,
  code: 'process.stdout.write("x")',
};
const skillDraft = { name: 'deploy-check', description: '发布前跑一遍', body: '# 步骤' };

type Harness = ReturnType<typeof harness>;

const applies: [SecretaryProposal['kind'], unknown, (h: Harness) => Promise<{ ok: boolean }>][] = [
  ['tool', toolDraft, (h) => h.tools.save(toolDraft, 'sec1')],
  ['skill', skillDraft, (h) => h.skills.save(skillDraft, 'sec1')],
  ['profile', { name: '小秘' }, (h) => h.profile.save({ name: '小秘' }, 'sec1')],
];

// 用户在秘书提案那一轮还没说完时点了确认：写盘后的释放推迟到这一轮结束。
// worker 收口时先报空闲、再发 turn-completed，宿主在空闲时已经投出「提案已执行」：
// 紧随其后的 turn-completed 属于提案那一轮，不能当成投递结束，否则释放会中止投递这一轮（Request aborted）
describe('提案那一轮还在跑时确认', () => {
  it.each(applies)(
    '确认 %s 提案：秘书只被唤醒一次，投递那一轮跑完才释放',
    async (kind, draft, apply) => {
      const h = harness();
      expect((await apply(h)).ok).toBe(true);
      expect(h.state.released).toEqual([]);
      h.state.file.outbox.push(
        proposalUpdate(
          {
            id: 'p1',
            secretaryConversationId: 'sec1',
            createdAt: 0,
            updatedAt: 1_000,
            status: 'succeeded',
            kind,
            draft,
          } as SecretaryProposal,
          1_000
        )
      );

      await h.finishTurn('t-propose');
      expect(h.state.prompts.map((prompt) => prompt.text)).toEqual([
        '<session-updates>\n- [proposal] 提案已执行\n</session-updates>',
      ]);
      expect(h.state.released).toEqual([]);

      h.deliveryStarted();
      await h.finishTurn('t-delivery');
      expect(h.state.released).toEqual(['sec1']);
      expect(h.state.prompts).toHaveLength(1);
      expect(h.state.file.outbox).toEqual([]);
      expect(h.state.file.inflight).toBeUndefined();
    }
  );
});
