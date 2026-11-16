import { parseProfile } from '@shared/secretary/parse';
import type {
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretarySchedule,
} from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import { createSecretaryProfile, type SecretaryProfilePorts } from './profile';
import { buildSecretarySystemPrompt } from './prompt';
import type { SecretarySessionStatus } from './readers';

const NOW = 5_000;

const baseProfile = (): SecretaryProfile => {
  const parsed = parseProfile({});
  if (!parsed) throw new Error('secretary default profile');
  return parsed;
};

const emptyFile = (): SecretaryDispatchFile => ({
  version: 1,
  dispatched: {},
  named: [],
  proposals: {},
  outbox: [],
});

const idle: SecretarySessionStatus = { state: 'idle', pendingAsks: 0, pendingApprovals: 0 };

interface Harness {
  ports: SecretaryProfilePorts;
  service: ReturnType<typeof createSecretaryProfile>;
  saved: SecretaryProfile | null;
  persona: string;
  rows: Record<string, Record<string, unknown>>;
  schedules: SecretarySchedule[];
  audits: SecretaryAuditEntry[];
  file: SecretaryDispatchFile;
  setModel: { conversationId: string; model: unknown }[];
  released: string[];
  /** 活着的会话当前用的系统提示词：spawn 与就地刷新都按盘上档案现拼 */
  prompts: Record<string, string>;
  clearedMemory: number;
  clearedFiles: number;
  notified: number;
}

function harness(
  options: {
    profile?: SecretaryProfile | null;
    persona?: string;
    schedules?: SecretarySchedule[];
    conversations?: string[];
    status?: (conversationId: string) => SecretarySessionStatus;
    alive?: (conversationId: string) => boolean;
  } = {}
): Harness {
  const h: Harness = {
    ports: undefined as unknown as SecretaryProfilePorts,
    service: undefined as unknown as ReturnType<typeof createSecretaryProfile>,
    saved: options.profile ?? null,
    persona: options.persona ?? '',
    rows: {},
    schedules: options.schedules ?? [],
    audits: [],
    file: emptyFile(),
    setModel: [],
    released: [],
    prompts: {},
    clearedMemory: 0,
    clearedFiles: 0,
    notified: 0,
  };
  const conversations = options.conversations ?? ['sec-1'];
  h.ports = {
    // 与磁盘一致：读出的是副本
    profile: () => structuredClone(h.saved),
    saveProfile: (profile) => {
      h.saved = structuredClone(profile);
      return profile;
    },
    persona: () => h.persona,
    writePersona: (persona) => {
      h.persona = persona;
    },
    clearFiles: () => {
      h.clearedFiles += 1;
      h.saved = null;
      h.persona = '';
    },
    clearPrivateMemory: async () => {
      h.clearedMemory += 1;
    },
    todos: () => [],
    schedules: () => h.schedules,
    saveSchedules: (schedules) => {
      h.schedules = schedules;
    },
    publish: () => undefined,
    conversations: async () =>
      conversations.map((conversationId) => ({
        conversationId,
        row: h.rows[conversationId],
      })),
    status: options.status ?? (() => idle),
    alive: options.alive ?? (() => true),
    setModel: async (conversationId, model) => {
      h.setModel.push({ conversationId, model });
      return { ok: true };
    },
    release: async (conversationId) => {
      h.released.push(conversationId);
      delete h.prompts[conversationId];
      return { ok: true };
    },
    refreshPrompt: (conversationId) => {
      h.prompts[conversationId] = promptFrom(h);
    },
    patchRow: (conversationId, patch) => {
      h.rows[conversationId] = { ...h.rows[conversationId], ...patch };
    },
    dispatchFile: () => h.file,
    saveDispatch: (file) => {
      h.file = file;
    },
    audit: (entry) => {
      h.audits.push(entry);
    },
    notify: () => {
      h.notified += 1;
    },
    now: () => NOW,
    newId: () => 'proposal-1',
  };
  h.service = createSecretaryProfile(h.ports);
  return h;
}

/** 与 Main 的 secretarySystemPrompt 同口径：每次现读档案与人设 */
function promptFrom(h: Harness): string {
  return buildSecretarySystemPrompt({
    profile: h.ports.profile(),
    persona: h.ports.persona(),
    uiLanguage: 'zh',
  });
}

describe('保存档案', () => {
  it('拒绝非法自主度且不写盘、不审计', async () => {
    const h = harness();
    expect(await h.service.save({ autonomy: 'god' }, null)).toEqual({
      ok: false,
      error: 'invalid autonomy',
    });
    expect(h.saved).toBeNull();
    expect(h.audits).toEqual([]);
    expect(h.notified).toBe(0);
  });

  it('拒绝非法模型与非法并发上限', async () => {
    const h = harness();
    expect(await h.service.save({ model: { providerId: 'p' } }, null)).toEqual({
      ok: false,
      error: 'invalid model',
    });
    expect(await h.service.save({ maxRunningDispatches: 99 }, null)).toEqual({
      ok: false,
      error: 'invalid maxRunningDispatches',
    });
  });

  it('未设置的档案从默认值起步', async () => {
    const h = harness();
    const result = await h.service.save({ name: '小秘', avatar: { color: '#0ea5e9' } }, null);
    expect(result.ok).toBe(true);
    expect(h.saved?.name).toBe('小秘');
    expect(h.saved?.avatar).toEqual({ color: '#0ea5e9' });
    expect(h.saved?.autonomy).toBe('ask-first');
    expect(h.saved?.updatedAt).toBe(NOW);
    expect(h.audits.map((entry) => entry.op)).toEqual(['profile_save']);
    expect(h.notified).toBe(1);
  });

  it('只改一部分时保留其余配置，null 清掉可选字段', async () => {
    const h = harness({
      profile: {
        ...baseProfile(),
        name: '旧名',
        addressAs: '老板',
        dailyBriefAt: '09:00',
        visibleProjectIds: ['p1'],
      },
    });
    await h.service.save({ name: '新名', dailyBriefAt: null }, null);
    expect(h.saved?.name).toBe('新名');
    expect(h.saved?.addressAs).toBe('老板');
    expect(h.saved?.visibleProjectIds).toEqual(['p1']);
    expect(h.saved?.dailyBriefAt).toBeUndefined();
  });

  it('写人设并保留头像图片版本', async () => {
    const h = harness({
      profile: { ...baseProfile(), avatar: { color: '#111111', imageVersion: 3 } },
    });
    await h.service.save({ persona: '说话简短。', avatar: { color: '#222222' } }, 'sec-1');
    expect(h.persona).toBe('说话简短。');
    expect(h.saved?.avatar).toEqual({ color: '#222222', imageVersion: 3 });
    expect(h.audits[0]?.secretaryConversationId).toBe('sec-1');
  });

  it('草案里的图片版本和路径改不了头像文件', async () => {
    const h = harness({
      profile: { ...baseProfile(), avatar: { color: '#111111', imageVersion: 3 } },
    });
    await h.service.save(
      {
        avatar: { color: '#abcdef', imageVersion: 99 },
      },
      null
    );
    expect(h.saved?.avatar).toEqual({ color: '#abcdef', imageVersion: 3 });
    expect(JSON.stringify(h.saved?.avatar)).not.toContain('/etc');
  });
});

describe('保存后的副作用', () => {
  it('模型变化时改会话行并对活着的会话设模型', async () => {
    const h = harness({ profile: baseProfile(), conversations: ['sec-1', 'sec-2'] });
    await h.service.save(
      { model: { providerId: 'anthropic', modelId: 'opus', thinkingLevel: 'high' } },
      null
    );
    expect(h.rows['sec-1']).toEqual({
      lastProviderId: 'anthropic',
      lastModelId: 'opus',
      thinkingLevel: 'high',
    });
    expect(h.rows['sec-2']).toEqual({
      lastProviderId: 'anthropic',
      lastModelId: 'opus',
      thinkingLevel: 'high',
    });
    expect(h.setModel.map((call) => call.conversationId)).toEqual(['sec-1', 'sec-2']);
    expect(h.released).toEqual([]);
  });

  it('模型没变时不动会话行，也不设模型', async () => {
    const model = { providerId: 'anthropic', modelId: 'opus' };
    const h = harness({ profile: { ...baseProfile(), model } });
    await h.service.save({ name: '换个名字' }, null);
    expect(h.rows).toEqual({});
    expect(h.setModel).toEqual([]);
  });

  it('名字变化时释放空闲会话，运行中的等本轮结束', async () => {
    const running = new Set(['sec-2']);
    const h = harness({
      conversations: ['sec-1', 'sec-2'],
      status: (conversationId) =>
        running.has(conversationId) ? { ...idle, state: 'running' } : idle,
    });
    await h.service.save({ name: '新名' }, null);
    expect(h.released).toEqual(['sec-1']);

    running.delete('sec-2');
    await h.service.onTurnEnded('sec-1');
    expect(h.released).toEqual(['sec-1']);
    await h.service.onTurnEnded('sec-2');
    expect(h.released).toEqual(['sec-1', 'sec-2']);
  });

  it('人设变化也算身份变化，只改模型时不释放', async () => {
    const h = harness({ profile: baseProfile(), persona: '旧人设' });
    await h.service.save({ model: { providerId: 'a', modelId: 'b' } }, null);
    expect(h.released).toEqual([]);
    await h.service.save({ persona: '新人设' }, null);
    expect(h.released).toEqual(['sec-1']);
  });

  it('初次设置完成后释放用旧提示词起的会话', async () => {
    const h = harness();
    await h.service.save({ name: '小秘' }, null);
    expect(h.released).toEqual(['sec-1']);
  });

  it('勾选的 skill 变了也释放会话，没变就不动', async () => {
    const h = harness({ profile: baseProfile() });
    await h.service.save({ skillIds: [] }, null);
    expect(h.released).toEqual([]);
    await h.service.save({ skillIds: ['s1'] }, null);
    expect(h.released).toEqual(['sec-1']);
  });

  it('releaseSessions 直接释放空闲会话，忙的留到本轮结束', async () => {
    const running = new Set(['sec-2']);
    const h = harness({
      conversations: ['sec-1', 'sec-2'],
      status: (conversationId) =>
        running.has(conversationId) ? { ...idle, state: 'running' } : idle,
    });
    await h.service.releaseSessions();
    expect(h.released).toEqual(['sec-1']);
    await h.service.onTurnEnded('sec-2');
    expect(h.released).toEqual(['sec-1', 'sec-2']);
  });

  it('改称呼后新会话的提示词用新称呼', async () => {
    const h = harness({ profile: { ...baseProfile(), addressAs: 'J 哥' }, conversations: [] });
    await h.service.save({ addressAs: '哥哥' }, null);
    expect(h.saved?.addressAs).toBe('哥哥');
    const prompt = promptFrom(h);
    expect(prompt).toContain('Address the user as "哥哥"');
    expect(prompt).not.toContain('J 哥');
  });

  it('改称呼后活着的旧会话就地换提示词：空闲与运行中都换，不释放、不重建', async () => {
    const h = harness({
      profile: { ...baseProfile(), addressAs: 'J 哥' },
      conversations: ['sec-1', 'sec-2', 'sec-dead'],
      status: (conversationId) =>
        conversationId === 'sec-2' ? { ...idle, state: 'running' } : idle,
      alive: (conversationId) => conversationId !== 'sec-dead',
    });
    await h.service.save({ addressAs: '哥哥' }, null);
    expect(Object.keys(h.prompts).sort()).toEqual(['sec-1', 'sec-2']);
    for (const prompt of Object.values(h.prompts)) {
      expect(prompt).toContain('Address the user as "哥哥"');
      expect(prompt).not.toContain('J 哥');
    }
    expect(h.released).toEqual([]);
    await h.service.onTurnEnded('sec-2');
    expect(h.released).toEqual([]);
  });

  it('旧会话重启后用新称呼', async () => {
    const h = harness({ profile: { ...baseProfile(), addressAs: 'J 哥' } });
    h.prompts['sec-1'] = promptFrom(h);
    await h.service.save({ addressAs: '哥哥' }, null);
    // 重启 = 释放后按盘上档案重新 spawn
    await h.ports.release('sec-1');
    h.prompts['sec-1'] = promptFrom(h);
    expect(h.prompts['sec-1']).toContain('Address the user as "哥哥"');
    expect(h.prompts['sec-1']).not.toContain('J 哥');
  });

  it('清掉称呼后提示词回到默认：不写称呼', async () => {
    const h = harness({ profile: { ...baseProfile(), addressAs: 'J 哥' } });
    await h.service.save({ addressAs: null }, null);
    expect(h.saved?.addressAs).toBeUndefined();
    expect(h.prompts['sec-1']).not.toContain('Address the user as');
  });

  it('每日简报时间变化时重算系统定时', async () => {
    const h = harness();
    await h.service.save({ dailyBriefAt: '08:30' }, null);
    expect(h.schedules.map((schedule) => schedule.id)).toEqual(['system:daily-brief']);
    expect(h.schedules[0]?.cron).toBe('30 8 * * *');
  });
});

describe('重来', () => {
  it('默认保留私有记忆，只清档案文件', async () => {
    const h = harness({ profile: baseProfile(), persona: '旧人设' });
    expect(await h.service.reset({ clearMemory: false }, null)).toEqual({ ok: true });
    expect(h.clearedFiles).toBe(1);
    expect(h.clearedMemory).toBe(0);
    expect(h.saved).toBeNull();
    expect(h.audits.map((entry) => entry.op)).toEqual(['profile_reset']);
    expect(h.notified).toBe(1);
  });

  it('clearMemory 时清空私有记忆并重算系统定时', async () => {
    const h = harness({
      profile: { ...baseProfile(), dailyBriefAt: '09:00' },
      schedules: [
        {
          id: 'system:daily-brief',
          name: '每日简报',
          prompt: '简报',
          cron: '0 9 * * *',
          createdAt: 1,
          system: 'daily-brief',
        },
      ],
    });
    await h.service.reset({ clearMemory: true }, null);
    expect(h.clearedMemory).toBe(1);
    expect(h.schedules).toEqual([]);
  });

  it('拒绝非法入参', async () => {
    const h = harness();
    expect(await h.service.reset({ clearMemory: 'yes' }, null)).toEqual({
      ok: false,
      error: 'invalid request',
    });
    expect(h.clearedFiles).toBe(0);
  });
});

describe('配置提案', () => {
  it('提交草案返回 awaiting_confirmation，不写档案', async () => {
    const h = harness();
    const result = await h.service.propose(
      { name: '小秘', avatarColor: '#0ea5e9', autonomy: 'tell-after', persona: '简短' },
      { secretaryConversationId: 'sec-1' }
    );
    expect(result).toEqual({
      ok: true,
      result: {
        status: 'awaiting_confirmation',
        proposalId: 'proposal-1',
        changes: [
          { field: 'name', before: null, after: '小秘' },
          { field: 'avatarColor', before: null, after: '#0ea5e9' },
          { field: 'autonomy', before: null, after: 'tell-after' },
          { field: 'persona', before: null, after: '简短' },
        ],
      },
    });
    expect(h.saved).toBeNull();
    const proposal = h.file.proposals['proposal-1'];
    expect(proposal?.kind).toBe('profile');
    expect(proposal?.status).toBe('pending');
    expect(proposal?.kind === 'profile' ? proposal.draft : null).toEqual({
      name: '小秘',
      avatar: { color: '#0ea5e9' },
      autonomy: 'tell-after',
      persona: '简短',
    });
  });

  it('提案能改派出的两个默认开关，卡片列出前后值', async () => {
    const h = harness({ profile: baseProfile() });
    const result = await h.service.propose(
      { dispatchMuted: false, dispatchUnattended: false },
      { secretaryConversationId: 'sec-1' }
    );
    expect(result).toEqual({
      ok: true,
      result: {
        status: 'awaiting_confirmation',
        proposalId: 'proposal-1',
        changes: [
          { field: 'dispatchMuted', before: true, after: false },
          { field: 'dispatchUnattended', before: true, after: false },
        ],
      },
    });
  });

  it('非秘书会话提交被拒，非法字段也拒', async () => {
    const h = harness();
    expect(await h.service.propose({ name: '小秘' }, { secretaryConversationId: null })).toEqual({
      ok: false,
      error: 'invalid arguments',
    });
    expect(
      await h.service.propose({ autonomy: 'god' }, { secretaryConversationId: 'sec-1' })
    ).toEqual({ ok: false, error: 'invalid autonomy' });
    expect(h.file.proposals).toEqual({});
  });

  it('提案不能写入图片路径或版本', async () => {
    const h = harness({
      profile: { ...baseProfile(), avatar: { color: '#111111', imageVersion: 3 } },
    });
    const result = await h.service.propose(
      {
        avatarColor: '#abcdef',
        avatar: { image: '/etc/passwd', imageVersion: 9, path: '../x' },
        image: '/tmp/avatar.png',
        avatarPath: '../avatar.png',
      },
      { secretaryConversationId: 'sec-1' }
    );
    expect(result.ok).toBe(true);
    expect(
      h.file.proposals['proposal-1']?.kind === 'profile'
        ? h.file.proposals['proposal-1'].draft.avatar
        : null
    ).toEqual({ color: '#abcdef' });
    expect(JSON.stringify(h.file.proposals)).not.toContain('/etc');
    expect(JSON.stringify(h.file.proposals)).not.toContain('imageVersion');
  });

  it('两处同时保存不同字段时都不丢', async () => {
    const h = harness({ profile: baseProfile() });
    await Promise.all([
      h.service.save({ addressAs: '老板' }, null),
      h.service.save({ dailyBriefAt: '09:30' }, null),
    ]);
    expect(h.saved).toMatchObject({ addressAs: '老板', dailyBriefAt: '09:30' });
  });
});
