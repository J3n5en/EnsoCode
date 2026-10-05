import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTeamSpec, type TeamSpec } from '../../../shared/bots/team';
import { BotStore } from './botStore';
import { BotChatStore } from './chatStore';
import { createTeam } from './teamCreate';

function member(key: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    name,
    title: 't',
    scope: 's',
    persona: `You are ${name}.`,
    avatar: { color: '#7c5cff' },
    tools: 'all',
    approvalMode: 'auto-edits',
    delegation: { canDelegateTo: 'any', acceptFrom: 'any' },
    memory: { enabled: true },
    ...extra,
  };
}

const team = parseTeamSpec({
  title: 'Squad',
  bossKey: 'pm',
  workspace: 'chat-home',
  routing: { mode: 'smart', maxHops: 6, maxTurnsPerBot: 2 },
  members: [
    member('pm', 'Lin', {
      tools: 'readonly',
      delegation: { canDelegateTo: ['fe'], acceptFrom: [] },
    }),
    member('fe', 'Fe', { delegation: { canDelegateTo: [], acceptFrom: ['pm'] } }),
    member('qa', 'Tester'),
  ],
}) as TeamSpec;

describe('createTeam', () => {
  let root: string;
  let bots: BotStore;
  let chats: BotChatStore;
  const workspace = { kind: 'chat-home' as const, projectId: 'p1' };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'enso-team-'));
    bots = new BotStore(join(root, 'bots'));
    chats = new BotChatStore(join(root, 'bot-chats'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const dirs = (name: string) =>
    existsSync(join(root, name)) ? readdirSync(join(root, name)) : [];

  it('一次性创建成员与群，委派按新 id 建立，重名与保留名自动加后缀', () => {
    bots.create({ name: 'Lin' }, []);
    const result = createTeam({ bots, chats }, team, {
      reserved: ['tester'],
      resolveWorkspace: () => workspace,
      releaseWorkspace: vi.fn(),
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.bots.map((bot) => bot.name)).toEqual(['Lin2', 'Fe', 'Tester2']);
    const [pm, fe] = result.bots;
    expect(pm.delegation).toEqual({ canDelegateTo: [fe.id], acceptFrom: [] });
    expect(fe.delegation).toEqual({ canDelegateTo: [], acceptFrom: [pm.id] });
    expect(pm.engine).toBeUndefined();
    expect(bots.readPersona(pm.id)).toBe('You are Lin.');
    expect(result.chat).toMatchObject({
      kind: 'group',
      title: 'Squad',
      bossBotId: pm.id,
      members: result.bots.map((bot) => bot.id),
      workspace,
      routing: { mode: 'smart', maxHops: 6, maxTurnsPerBot: 2 },
    });
    expect(chats.list()).toHaveLength(1);
  });

  it('中途创建成员失败时回滚已建成员，不建群也不占工作区', () => {
    const resolveWorkspace = vi.fn(() => workspace);
    let calls = 0;
    const flaky = {
      list: () => bots.list(),
      remove: (id: string) => bots.remove(id),
      create: (...args: Parameters<BotStore['create']>) => {
        calls += 1;
        if (calls === 2) throw new Error('disk full');
        return bots.create(...args);
      },
    };
    const result = createTeam({ bots: flaky, chats }, team, {
      reserved: [],
      resolveWorkspace,
      releaseWorkspace: vi.fn(),
    });
    expect(result).toEqual({ ok: false, error: 'disk full' });
    expect(bots.list()).toEqual([]);
    expect(dirs('bots')).toEqual([]);
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });

  it('工作区解析失败或建群失败时回滚成员并释放工作区', () => {
    const failed = createTeam({ bots, chats }, team, {
      reserved: [],
      resolveWorkspace: () => ({ error: 'workspace-unavailable' }),
      releaseWorkspace: vi.fn(),
    });
    expect(failed).toEqual({ ok: false, error: 'workspace-unavailable' });
    expect(bots.list()).toEqual([]);

    const releaseWorkspace = vi.fn();
    const broken = { create: () => undefined };
    const result = createTeam({ bots, chats: broken }, team, {
      reserved: [],
      resolveWorkspace: () => workspace,
      releaseWorkspace,
    });
    expect(result).toEqual({ ok: false, error: 'invalid' });
    expect(bots.list()).toEqual([]);
    expect(dirs('bots')).toEqual([]);
    expect(releaseWorkspace).toHaveBeenCalledWith(expect.any(String), workspace);
  });
});
