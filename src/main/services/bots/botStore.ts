import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { migrateRecord, withSchemaVersion } from '../../../shared/bots/migrations';
import { type BotProfile, checkBotName, isBotId, parseBotProfile } from '../../../shared/types/bot';
import { readJson, writeAtomic, writeJsonAtomic } from './files';

export type BotDraft = Partial<
  Pick<
    BotProfile,
    | 'name'
    | 'title'
    | 'scope'
    | 'avatar'
    | 'engine'
    | 'approvalMode'
    | 'tools'
    | 'skillIds'
    | 'mcpServerIds'
    | 'delegation'
    | 'memory'
    | 'budget'
    | 'delegationTimeoutMinutes'
    | 'maxTokensPerTurn'
  >
> & { persona?: string };

export type BotWriteResult =
  | { ok: true; bot: BotProfile }
  | { ok: false; reason: 'invalid' | 'reserved' | 'duplicate' | 'not-found' | 'conflict' };

/** userData/bots/<botId>/{bot.json, persona.md, workspace/} */
export class BotStore {
  private bots = new Map<string, BotProfile>();

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now
  ) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      if (!isBotId(name)) continue;
      const bot = parseBotProfile(migrateRecord('bot', readJson(join(root, name, 'bot.json'))));
      if (bot?.id === name) this.bots.set(name, bot);
    }
  }

  list(): BotProfile[] {
    return [...this.bots.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): BotProfile | undefined {
    return this.bots.get(id);
  }

  homeDir(id: string): string {
    return join(this.dir(id), 'workspace');
  }

  /** 只在档案标记有图时返回 avatar.png 路径 */
  avatarPath(id: string): string | null {
    if (!this.bots.get(id)?.avatar.image) return null;
    const file = join(this.dir(id), 'avatar.png');
    return existsSync(file) ? file : null;
  }

  /** 写入 / 删除头像图片（字节已由调用方校验） */
  setAvatar(id: string, image: Uint8Array | null): BotWriteResult {
    const current = this.bots.get(id);
    if (!current) return { ok: false, reason: 'not-found' };
    const file = join(this.dir(id), 'avatar.png');
    if (image) writeAtomic(file, image);
    else rmSync(file, { force: true });
    const version = current.version + 1;
    const bot: BotProfile = {
      ...current,
      avatar: { color: current.avatar.color, ...(image ? { image: version } : {}) },
      updatedAt: this.now(),
      version,
    };
    this.persist(bot);
    return { ok: true, bot };
  }

  readPersona(id: string): string {
    if (!isBotId(id)) return '';
    try {
      return readFileSync(join(this.dir(id), 'persona.md'), 'utf8');
    } catch {
      return '';
    }
  }

  create(draft: BotDraft, reserved: readonly string[], id: string = randomUUID()): BotWriteResult {
    const at = this.now();
    return this.write(
      undefined,
      { ...draft, id, createdAt: at, updatedAt: at, version: 1 },
      reserved,
      draft.persona ?? ''
    );
  }

  update(
    id: string,
    draft: BotDraft,
    reserved: readonly string[],
    expectedVersion?: number
  ): BotWriteResult {
    const current = this.bots.get(id);
    if (!current) return { ok: false, reason: 'not-found' };
    if (expectedVersion !== undefined && expectedVersion !== current.version)
      return { ok: false, reason: 'conflict' };
    const { persona, ...fields } = draft;
    return this.write(
      current,
      {
        ...current,
        ...fields,
        // 草稿只改颜色；图片只经 setAvatar 变更
        avatar: { ...current.avatar, ...fields.avatar },
        id,
        createdAt: current.createdAt,
        updatedAt: this.now(),
        version: current.version + 1,
      },
      reserved,
      persona
    );
  }

  setArchived(id: string, archived: boolean): BotWriteResult {
    const current = this.bots.get(id);
    if (!current) return { ok: false, reason: 'not-found' };
    const { archivedAt: _, ...rest } = current;
    const at = this.now();
    const bot: BotProfile = {
      ...rest,
      updatedAt: at,
      version: current.version + 1,
      ...(archived ? { archivedAt: at } : {}),
    };
    this.persist(bot);
    return { ok: true, bot };
  }

  remove(id: string): boolean {
    if (!isBotId(id) || !this.bots.has(id)) return false;
    rmSync(this.dir(id), { recursive: true, force: true });
    this.bots.delete(id);
    return true;
  }

  private write(
    current: BotProfile | undefined,
    candidate: Record<string, unknown>,
    reserved: readonly string[],
    persona: string | undefined
  ): BotWriteResult {
    const name = checkBotName(String(candidate.name ?? ''), this.list(), reserved, current?.id);
    if (!name.ok) return name;
    const bot = parseBotProfile({ ...candidate, name: name.name });
    if (!bot) return { ok: false, reason: 'invalid' };
    if (persona !== undefined) writeAtomic(join(this.dir(bot.id), 'persona.md'), persona);
    this.persist(bot);
    return { ok: true, bot };
  }

  private persist(bot: BotProfile): void {
    writeJsonAtomic(join(this.dir(bot.id), 'bot.json'), withSchemaVersion('bot', bot));
    this.bots.set(bot.id, bot);
  }

  private dir(id: string): string {
    if (!isBotId(id)) throw new Error('Invalid bot id');
    return join(this.root, id);
  }
}
