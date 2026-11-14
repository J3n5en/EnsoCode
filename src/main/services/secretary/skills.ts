import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { app } from '@platform';
import {
  isSecretarySkillName,
  parseSecretarySkillDraft,
  parseSecretarySkillFile,
  renderSecretarySkillFile,
} from '@shared/secretary/skills';
import type {
  SecretaryAuditEntry,
  SecretaryDispatchFile,
  SecretarySkillDraft,
} from '@shared/types/secretary';
import { writeAtomic } from '../bots/files';
import { appendAudit } from './audit';
import { notifySecretaryChanged } from './dispatch';
import { SecretaryStore } from './store';
import type { SecretaryOpContext, SecretaryOpHandler, SecretaryOpResult } from './tools';

const SKILL_FILE = 'SKILL.md';

export type SkillSaveResult = { ok: true; name: string } | { ok: false; error: string };

/** 目录里每个子目录一份 SKILL.md；读不懂的跳过，坏文件不能顶掉整张列表 */
export function listSecretarySkills(dir: string): SecretarySkillDraft[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const skills: SecretarySkillDraft[] = [];
  for (const name of entries.sort()) {
    const skill = readSecretarySkill(dir, name);
    if (skill) skills.push(skill);
  }
  return skills;
}

/** 只接受合法 slug：路径由 dir 与 name 拼出，name 里不可能出现分隔符或 .. */
export function readSecretarySkill(dir: string, name: string): SecretarySkillDraft | null {
  if (!isSecretarySkillName(name)) return null;
  try {
    return parseSecretarySkillFile(readFileSync(path.join(dir, name, SKILL_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export function writeSecretarySkill(dir: string, draft: SecretarySkillDraft): void {
  if (!isSecretarySkillName(draft.name)) throw new Error('invalid skill name');
  writeAtomic(path.join(dir, draft.name, SKILL_FILE), renderSecretarySkillFile(draft));
}

export function removeSecretarySkill(dir: string, name: string): boolean {
  if (!isSecretarySkillName(name)) return false;
  const target = path.join(dir, name);
  if (!existsSync(target) || !statSync(target).isDirectory()) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}

/** Main 侧的 skill 写入数据源；测试注入假实现，生产走文件末尾的 secretarySkillPorts */
export interface SecretarySkillPorts {
  dir(): string;
  dispatchFile(): SecretaryDispatchFile;
  saveDispatch(file: SecretaryDispatchFile): void;
  audit(entry: SecretaryAuditEntry): void;
  notify(): void;
  /** skill 在 spawn 时定死：写完释放空闲会话，忙的等本轮结束 */
  releaseSessions(): Promise<void>;
  now(): number;
  newId(): string;
}

export interface SecretarySkillService {
  propose(params: Record<string, unknown>, ctx: SecretaryOpContext): Promise<SecretaryOpResult>;
  save(draft: unknown, secretaryConversationId: string | null): Promise<SkillSaveResult>;
  remove(request: unknown, secretaryConversationId: string | null): Promise<SkillSaveResult>;
  list(): SecretarySkillDraft[];
}

function nameParam(request: unknown): string | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const name = (request as { name?: unknown }).name;
  return isSecretarySkillName(name) ? name : null;
}

export function createSecretarySkills(ports: SecretarySkillPorts): SecretarySkillService {
  function audit(
    op: string,
    secretaryConversationId: string | null,
    ok: boolean,
    detail?: string,
    targetId?: string
  ): void {
    ports.audit({
      at: ports.now(),
      secretaryConversationId,
      op,
      ...(targetId ? { targetId } : {}),
      ok,
      ...(detail ? { detail } : {}),
    });
  }

  async function release(): Promise<void> {
    try {
      await ports.releaseSessions();
    } catch (error) {
      // 文件已经落盘：释放失败不能报成保存失败，下一轮 spawn 仍会读到新内容
      console.warn('[secretary] releasing sessions after a skill change failed:', error);
    }
  }

  return {
    async propose(params, ctx) {
      if (!ctx.secretaryConversationId) return { ok: false, error: 'invalid arguments' };
      const parsed = parseSecretarySkillDraft(params);
      if (!parsed.ok) return parsed;
      const dir = ports.dir();
      const existing = readSecretarySkill(dir, parsed.draft.name);
      const now = ports.now();
      const id = ports.newId();
      const file = ports.dispatchFile();
      file.proposals[id] = {
        id,
        secretaryConversationId: ctx.secretaryConversationId,
        createdAt: now,
        updatedAt: now,
        status: 'pending',
        kind: 'skill',
        draft: parsed.draft,
        ...(existing
          ? { previous: { description: existing.description, body: existing.body } }
          : {}),
      };
      ports.saveDispatch(file);
      audit(
        'secretary_skill_propose',
        ctx.secretaryConversationId,
        true,
        'awaiting_confirmation',
        id
      );
      ports.notify();
      return { ok: true, result: { status: 'awaiting_confirmation', proposalId: id } };
    },

    async save(draft, secretaryConversationId) {
      const parsed = parseSecretarySkillDraft(draft);
      if (!parsed.ok) {
        audit('skill_save', secretaryConversationId, false, parsed.error);
        return parsed;
      }
      try {
        writeSecretarySkill(ports.dir(), parsed.draft);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        audit('skill_save', secretaryConversationId, false, message, parsed.draft.name);
        return { ok: false, error: message };
      }
      audit('skill_save', secretaryConversationId, true, 'succeeded', parsed.draft.name);
      await release();
      ports.notify();
      return { ok: true, name: parsed.draft.name };
    },

    async remove(request, secretaryConversationId) {
      const name = nameParam(request);
      if (!name) return { ok: false, error: 'invalid request' };
      if (!removeSecretarySkill(ports.dir(), name)) {
        audit('skill_delete', secretaryConversationId, false, 'not-found', name);
        return { ok: false, error: 'not-found' };
      }
      audit('skill_delete', secretaryConversationId, true, 'deleted', name);
      await release();
      ports.notify();
      return { ok: true, name };
    },

    list() {
      return listSecretarySkills(ports.dir());
    },
  };
}

/** 秘书工作区就是秘书项目的 cwd：自有 skill 放在它下面的 skills/ */
export function secretarySkillsDir(): string {
  return path.join(app.getPath('userData'), 'secretary', 'workspace', 'skills');
}

export const secretarySkillPorts: SecretarySkillPorts = {
  dir: () => secretarySkillsDir(),
  dispatchFile: () => store().dispatch(),
  saveDispatch: (file) => {
    store().saveDispatch(file);
  },
  audit: (entry) => appendAudit(path.join(app.getPath('userData'), 'secretary'), entry),
  notify: () => {
    notifySecretaryChanged();
  },
  releaseSessions: async () => {
    const { secretaryProfile } = await import('./profile');
    await secretaryProfile.releaseSessions();
  },
  now: () => Date.now(),
  newId: () => randomUUID(),
};

function store(): SecretaryStore {
  return new SecretaryStore(path.join(app.getPath('userData'), 'secretary'));
}

export const secretarySkill = createSecretarySkills(secretarySkillPorts);

export const secretarySkillHandlers: { skill_propose: SecretaryOpHandler } = {
  skill_propose: (params, ctx) => secretarySkill.propose(params, ctx),
};
