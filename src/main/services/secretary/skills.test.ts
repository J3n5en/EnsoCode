import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretarySkillDraft,
} from '@shared/types/secretary';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSecretarySkills,
  listSecretarySkills,
  readGlobalSkillBody,
  readSecretarySkill,
  removeSecretarySkill,
  type SecretarySkillPorts,
  secretarySkillDirs,
  secretarySkillViews,
  withGlobalSkillEnabled,
  withOwnSkillEnabled,
  writeSecretarySkill,
} from './skills';

const NOW = 7_000;
const ctx = { secretaryConversationId: 'sec-1' };
const draft: SecretarySkillDraft = {
  name: 'deploy-check',
  description: '发布前跑一遍',
  body: '# 步骤\n\n- 跑测试',
};

const emptyFile = (): SecretaryDispatchFile => ({
  version: 1,
  dispatched: {},
  named: [],
  proposals: {},
  outbox: [],
});

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'secretary-skills-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('skill files on disk', () => {
  it('writes one SKILL.md per slug and reads it back', () => {
    writeSecretarySkill(dir, draft);
    expect(readFileSync(path.join(dir, draft.name, 'SKILL.md'), 'utf8')).toContain(
      'name: deploy-check'
    );
    expect(readSecretarySkill(dir, draft.name)).toEqual(draft);
    expect(listSecretarySkills(dir)).toEqual([draft]);
  });

  it('refuses to read or write outside the skills directory', () => {
    expect(readSecretarySkill(dir, '../escape')).toBeNull();
    expect(() => writeSecretarySkill(dir, { ...draft, name: '../escape' })).toThrow(
      'invalid skill name'
    );
    expect(removeSecretarySkill(dir, '../escape')).toBe(false);
  });

  it('skips a broken file instead of failing the whole list', () => {
    writeSecretarySkill(dir, draft);
    writeSecretarySkill(dir, { ...draft, name: 'second' });
    writeSecretarySkill(dir, { ...draft, name: 'broken' });
    rmSync(path.join(dir, 'broken', 'SKILL.md'), { force: true });
    expect(listSecretarySkills(dir).map((skill) => skill.name)).toEqual(['deploy-check', 'second']);
  });

  it('removes the directory and reports whether it existed', () => {
    writeSecretarySkill(dir, draft);
    expect(removeSecretarySkill(dir, draft.name)).toBe(true);
    expect(removeSecretarySkill(dir, draft.name)).toBe(false);
    expect(listSecretarySkills(dir)).toEqual([]);
  });
});

interface Harness {
  ports: SecretarySkillPorts;
  service: ReturnType<typeof createSecretarySkills>;
  file: SecretaryDispatchFile;
  audits: SecretaryAuditEntry[];
  released: number;
  notified: number;
}

function harness(): Harness {
  let ids = 0;
  const h: Harness = {
    file: emptyFile(),
    audits: [],
    released: 0,
    notified: 0,
    ports: undefined as unknown as SecretarySkillPorts,
    service: undefined as unknown as ReturnType<typeof createSecretarySkills>,
  };
  h.ports = {
    dir: () => dir,
    dispatchFile: () => structuredClone(h.file),
    saveDispatch: (file) => {
      h.file = structuredClone(file);
    },
    audit: (entry) => {
      h.audits.push(entry);
    },
    notify: () => {
      h.notified += 1;
    },
    releaseSessions: async () => {
      h.released += 1;
    },
    now: () => NOW,
    newId: () => `id-${++ids}`,
  };
  h.service = createSecretarySkills(h.ports);
  return h;
}

describe('skill_propose', () => {
  it('只出提案，不写盘', async () => {
    const h = harness();
    const result = await h.service.propose({ ...draft }, ctx);
    expect(result).toEqual({
      ok: true,
      result: { status: 'awaiting_confirmation', proposalId: 'id-1' },
    });
    expect(listSecretarySkills(dir)).toEqual([]);
    expect(h.file.proposals['id-1']).toMatchObject({
      kind: 'skill',
      status: 'pending',
      secretaryConversationId: 'sec-1',
      draft,
    });
    expect(h.file.proposals['id-1'].kind === 'skill' && h.file.proposals['id-1'].previous).toBe(
      undefined
    );
    expect(h.audits).toEqual([
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'secretary_skill_propose',
        targetId: 'id-1',
        ok: true,
        detail: 'awaiting_confirmation',
      },
    ]);
  });

  it('同名 skill 已存在时带上旧内容', async () => {
    writeSecretarySkill(dir, { ...draft, description: '旧描述', body: '# 旧步骤' });
    const h = harness();
    await h.service.propose({ ...draft }, ctx);
    const proposal = h.file.proposals['id-1'];
    expect(proposal.kind === 'skill' && proposal.previous).toEqual({
      description: '旧描述',
      body: '# 旧步骤',
    });
  });

  it('拒绝非法 slug 与越界正文', async () => {
    const h = harness();
    expect(await h.service.propose({ ...draft, name: '../escape' }, ctx)).toEqual({
      ok: false,
      error: 'invalid skill name',
    });
    expect(await h.service.propose({ ...draft, body: '' }, ctx)).toEqual({
      ok: false,
      error: 'invalid skill body',
    });
    expect(h.file.proposals).toEqual({});
  });
});

describe('skill save and delete', () => {
  it('写盘后审计并释放会话', async () => {
    const h = harness();
    expect(await h.service.save(draft, 'sec-1')).toEqual({ ok: true, name: 'deploy-check' });
    expect(readSecretarySkill(dir, 'deploy-check')).toEqual(draft);
    expect(h.audits).toEqual([
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'skill_save',
        targetId: 'deploy-check',
        ok: true,
        detail: 'succeeded',
      },
    ]);
    expect(h.released).toBe(1);
    expect(h.notified).toBe(1);
  });

  it('写入失败时审计记失败并带原因', async () => {
    const h = harness();
    const result = await h.service.save({ ...draft, name: 'Bad Name' }, 'sec-1');
    expect(result).toEqual({ ok: false, error: 'invalid skill name' });
    expect(h.audits).toEqual([
      {
        at: NOW,
        secretaryConversationId: 'sec-1',
        op: 'skill_save',
        ok: false,
        detail: 'invalid skill name',
      },
    ]);
    expect(h.released).toBe(0);
  });

  it('删除后审计并释放会话，不存在时报 not-found', async () => {
    writeSecretarySkill(dir, draft);
    const h = harness();
    expect(await h.service.remove({ name: 'deploy-check' }, null)).toEqual({
      ok: true,
      name: 'deploy-check',
    });
    expect(listSecretarySkills(dir)).toEqual([]);
    expect(h.audits[0]).toMatchObject({ op: 'skill_delete', ok: true, targetId: 'deploy-check' });
    expect(h.released).toBe(1);
    expect(await h.service.remove({ name: 'deploy-check' }, null)).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(await h.service.remove({ name: '../escape' }, null)).toEqual({
      ok: false,
      error: 'invalid request',
    });
  });
});

describe('skill 视图与启停', () => {
  it('自有在前、全局在后，停用的标出来', () => {
    const views = secretarySkillViews({
      own: [draft],
      disabledOwn: [],
      global: [
        { id: 's-review', name: 'review', description: '审代码' },
        { id: 's-deploy', name: 'deploy', description: '' },
      ],
      enabledGlobalIds: ['s-review'],
    });
    expect(views).toEqual([
      {
        id: 'deploy-check',
        name: 'deploy-check',
        description: '发布前跑一遍',
        source: 'own',
        enabled: true,
        body: '# 步骤\n\n- 跑测试',
      },
      {
        id: 's-review',
        name: 'review',
        description: '审代码',
        source: 'global',
        enabled: true,
      },
      { id: 's-deploy', name: 'deploy', description: '', source: 'global', enabled: false },
    ]);
    expect(
      secretarySkillViews({
        own: [draft],
        disabledOwn: ['deploy-check'],
        global: [],
        enabledGlobalIds: [],
      })[0].enabled
    ).toBe(false);
  });

  it('启停只动自己那一条，重复开关不会留下脏数据', () => {
    expect(withOwnSkillEnabled([], 'deploy-check', false)).toEqual(['deploy-check']);
    expect(withOwnSkillEnabled(['deploy-check'], 'deploy-check', true)).toEqual([]);
    expect(withOwnSkillEnabled(['a'], 'b', false)).toEqual(['a', 'b']);
    expect(withGlobalSkillEnabled([], 's-review', true)).toEqual(['s-review']);
    expect(withGlobalSkillEnabled(['s-review'], 's-review', true)).toEqual(['s-review']);
    expect(withGlobalSkillEnabled(['s-review', 's-deploy'], 's-review', false)).toEqual([
      's-deploy',
    ]);
  });

  it('全局 skill 的正文只从它自己的目录读，读不到就是 null', () => {
    writeSecretarySkill(dir, draft);
    expect(readGlobalSkillBody(path.join(dir, 'deploy-check'))).toContain('# 步骤');
    expect(readGlobalSkillBody(path.join(dir, 'missing'))).toBeNull();
  });

  it('挂给会话的自有目录跳过停用的与读不懂的', () => {
    writeSecretarySkill(dir, draft);
    writeSecretarySkill(dir, { ...draft, name: 'review' });
    const dirs = secretarySkillDirs(dir, ['review']);
    expect(dirs.map((entry) => path.basename(entry))).toEqual(['deploy-check']);
  });
});
