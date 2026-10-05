import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotStore } from './botStore';

let root: string;
let store: BotStore;
let clock = 1000;
const now = () => ++clock;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-store-'));
  store = new BotStore(root, now);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('BotStore', () => {
  it('creates a bot with persona and survives reload', () => {
    const created = store.create({ name: 'Alice', title: '后端', persona: '你是 Alice' }, []);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.bot).toMatchObject({
      name: 'Alice',
      title: '后端',
      approvalMode: 'full',
      version: 1,
    });

    const reloaded = new BotStore(root, now);
    expect(reloaded.list().map((bot) => bot.id)).toEqual([created.bot.id]);
    expect(reloaded.readPersona(created.bot.id)).toBe('你是 Alice');
  });

  it('rejects invalid, reserved and duplicate names', () => {
    expect(store.create({ name: 'a b' }, [])).toEqual({ ok: false, reason: 'invalid' });
    expect(store.create({ name: 'scout' }, ['scout'])).toEqual({ ok: false, reason: 'reserved' });
    expect(store.create({ name: 'Alice' }, []).ok).toBe(true);
    expect(store.create({ name: 'alice' }, [])).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('updates with version check and keeps immutable fields', () => {
    const created = store.create({ name: 'Alice' }, []);
    if (!created.ok) throw new Error('create failed');
    const { id, createdAt } = created.bot;

    const updated = store.update(id, { title: '全栈', tools: 'readonly' }, [], 1);
    expect(updated).toMatchObject({
      ok: true,
      bot: { id, createdAt, title: '全栈', tools: 'readonly', version: 2 },
    });
    expect(store.update(id, { title: 'x' }, [], 1)).toEqual({ ok: false, reason: 'conflict' });
    expect(store.update('44444444-4444-4444-8444-444444444444', { title: 'x' }, [])).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('lets a bot keep its own name on rename check', () => {
    const a = store.create({ name: 'Alice' }, []);
    const b = store.create({ name: 'Bob' }, []);
    if (!a.ok || !b.ok) throw new Error('create failed');
    expect(store.update(a.bot.id, { name: 'ALICE' }, []).ok).toBe(true);
    expect(store.update(a.bot.id, { name: 'bob' }, [])).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('archives and restores', () => {
    const created = store.create({ name: 'Alice' }, []);
    if (!created.ok) throw new Error('create failed');
    expect(store.setArchived(created.bot.id, true).ok).toBe(true);
    expect(store.get(created.bot.id)?.archivedAt).toBeTypeOf('number');
    expect(store.setArchived(created.bot.id, false).ok).toBe(true);
    expect(store.get(created.bot.id)?.archivedAt).toBeUndefined();
  });

  it('removes the whole bot directory including home', () => {
    const created = store.create({ name: 'Alice' }, []);
    if (!created.ok) throw new Error('create failed');
    const home = store.homeDir(created.bot.id);
    mkdirSync(home, { recursive: true });
    expect(store.remove(created.bot.id)).toBe(true);
    expect(existsSync(join(root, created.bot.id))).toBe(false);
    expect(store.get(created.bot.id)).toBeUndefined();
  });

  it('never touches paths outside the store for bad ids', () => {
    const outside = join(root, '..', `${Date.now()}-keep`);
    mkdirSync(outside);
    try {
      expect(store.remove(`../${outside.split('/').pop()}`)).toBe(false);
      expect(existsSync(outside)).toBe(true);
      expect(store.readPersona('../etc')).toBe('');
      expect(() => store.homeDir('../x')).toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips corrupt bot files and stray entries when listing', () => {
    const created = store.create({ name: 'Alice' }, []);
    if (!created.ok) throw new Error('create failed');
    const broken = join(root, '55555555-5555-4555-8555-555555555555');
    mkdirSync(broken);
    writeFileSync(join(broken, 'bot.json'), '{oops');
    mkdirSync(join(root, 'not-a-bot'));
    writeFileSync(join(root, 'stray.txt'), 'x');
    expect(new BotStore(root, now).list().map((bot) => bot.name)).toEqual(['Alice']);
  });

  it('ignores a bot.json whose id disagrees with its directory', () => {
    const created = store.create({ name: 'Alice' }, []);
    if (!created.ok) throw new Error('create failed');
    const other = join(root, '66666666-6666-4666-8666-666666666666');
    mkdirSync(other);
    writeFileSync(`${other}/bot.json`, readFileSync(join(root, created.bot.id, 'bot.json')));
    expect(new BotStore(root, now).list()).toHaveLength(1);
  });

  it('stores avatar.png, versions it, keeps it across edits / archive and removes it', () => {
    const created = store.create({ name: 'Alice' }, []);
    if (!created.ok) throw new Error('create failed');
    const id = created.bot.id;
    const file = join(root, id, 'avatar.png');
    expect(store.avatarPath(id)).toBeNull();

    const set = store.setAvatar(id, Uint8Array.of(1, 2, 3));
    expect(set.ok && set.bot.avatar).toEqual({ color: created.bot.avatar.color, image: 2 });
    expect([...readFileSync(file)]).toEqual([1, 2, 3]);
    expect(store.avatarPath(id)).toBe(file);

    const edited = store.update(id, { avatar: { color: '#112233' } }, []);
    expect(edited.ok && edited.bot.avatar).toEqual({ color: '#112233', image: 2 });
    store.setArchived(id, true);
    expect(new BotStore(root, now).get(id)?.avatar.image).toBe(2);
    expect(existsSync(file)).toBe(true);

    const cleared = store.setAvatar(id, null);
    expect(cleared.ok && cleared.bot.avatar).toEqual({ color: '#112233' });
    expect(existsSync(file)).toBe(false);
    expect(store.avatarPath(id)).toBeNull();
    expect(store.setAvatar('missing', null)).toEqual({ ok: false, reason: 'not-found' });
  });
});
