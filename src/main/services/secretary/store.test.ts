import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SecretaryProfile } from '../../../shared/types/secretary';
import { SecretaryStore } from './store';

let dir: string;
let store: SecretaryStore;
let clock = 1000;
const now = () => ++clock;

const profile: SecretaryProfile = {
  version: 1,
  name: '小秘',
  avatar: { color: '#0ea5e9' },
  autonomy: 'tell-after',
  autoApproveProjectIds: ['p1'],
  takeoverScope: { mode: 'projects', projectIds: [] },
  pluginIds: [],
  skillIds: [],
  visibleProjectIds: 'all',
  dispatchModel: { mode: 'project' },
  dispatchWorktree: 'auto',
  maxRunningDispatches: 3,
  patrolEnabled: true,
  patrolIntervalMinutes: 15,
  patrolIdleGoalMinutes: 3,
  orphanTaskPatrol: true,
  dispatchMuted: true,
  dispatchUnattended: true,
  replyLanguage: 'ui',
  style: 'concise',
  notify: 'needs-user',
  updatedAt: 1,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secretary-store-'));
  store = new SecretaryStore(dir, now);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SecretaryStore', () => {
  it('reports no profile before the first setup', () => {
    expect(store.profile()).toBeNull();
    expect(store.readPersona()).toBe('');
    expect(store.avatarPath()).toBeNull();
  });

  it('round-trips the profile through profile.json', () => {
    expect(store.saveProfile(profile)).toEqual(profile);
    expect(JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'))).toEqual(profile);
    expect(new SecretaryStore(dir, now).profile()).toEqual(profile);
  });

  it('normalizes the profile before writing it', () => {
    const saved = store.saveProfile({
      ...profile,
      maxRunningDispatches: 42,
      autonomy: 'nope',
    } as never);
    expect(saved.maxRunningDispatches).toBe(10);
    expect(saved.autonomy).toBe('ask-first');
    expect(new SecretaryStore(dir, now).profile()).toEqual(saved);
  });

  it('treats a corrupt profile.json as not configured', () => {
    writeFileSync(join(dir, 'profile.json'), '{ not json');
    expect(store.profile()).toBeNull();
    writeFileSync(join(dir, 'profile.json'), '[1,2]');
    expect(store.profile()).toBeNull();
  });

  it('clears profile.json, persona.md and avatar.png on reset', () => {
    store.saveProfile(profile);
    store.writePersona('说话简短。');
    store.setAvatar(new Uint8Array([1, 2, 3]));
    store.clearProfile();
    expect(store.profile()).toBeNull();
    expect(store.readPersona()).toBe('');
    expect(store.avatarPath()).toBeNull();
    expect(existsSync(join(dir, 'profile.json'))).toBe(false);
    expect(existsSync(join(dir, 'persona.md'))).toBe(false);
    expect(existsSync(join(dir, 'avatar.png'))).toBe(false);
  });

  it('round-trips persona.md', () => {
    store.writePersona('说话简短。');
    expect(store.readPersona()).toBe('说话简短。');
    expect(new SecretaryStore(dir, now).readPersona()).toBe('说话简短。');
  });

  it('stores avatar.png and bumps its version, then removes both', () => {
    store.saveProfile(profile);
    const first = store.setAvatar(new Uint8Array([1, 2, 3]))?.avatar;
    expect(first).toMatchObject({ color: '#0ea5e9', imageVersion: 1 });
    expect(first?.imageHash).toMatch(/^[0-9a-f]{8}$/u);
    expect(existsSync(join(dir, 'avatar.png'))).toBe(true);
    expect(store.avatarPath()).toBe(realpathSync(join(dir, 'avatar.png')));

    const second = store.setAvatar(new Uint8Array([4]))?.avatar;
    expect(second).toMatchObject({ color: '#0ea5e9', imageVersion: 2 });
    // 换图后 URL 上的指纹必须跟着变：只靠版本号在档案被重来后可能撞回同一个地址
    expect(second?.imageHash).not.toBe(first?.imageHash);
    expect(store.avatarPath()).toBe(realpathSync(join(dir, 'avatar.png')));

    expect(store.setAvatar(null)?.avatar).toEqual({ color: '#0ea5e9' });
    expect(existsSync(join(dir, 'avatar.png'))).toBe(false);
    expect(store.avatarPath()).toBeNull();
  });

  it('档案没写成功就把图片回滚，不留下「字节换了、版本没换」的半成品', () => {
    store.saveProfile(profile);
    store.setAvatar(new Uint8Array([1, 2, 3]));
    const before = readFileSync(join(dir, 'avatar.png'));
    const broken = new SecretaryStore(dir, now);
    broken.saveProfile = () => {
      throw new Error('disk full');
    };
    expect(() => broken.setAvatar(new Uint8Array([9, 9, 9]))).toThrow('disk full');
    expect(readFileSync(join(dir, 'avatar.png'))).toEqual(before);
    expect(store.profile()?.avatar.imageVersion).toBe(1);
  });

  it('ignores an avatar write when no profile exists', () => {
    expect(store.setAvatar(new Uint8Array([1]))).toBeNull();
    expect(existsSync(join(dir, 'avatar.png'))).toBe(false);
  });

  it('does not follow an avatar symlink out of the secretary directory', () => {
    store.saveProfile(profile);
    store.setAvatar(new Uint8Array([1, 2, 3]));
    const outside = join(dir, '..', `sec-escape-${process.pid}.png`);
    writeFileSync(outside, 'secret');
    rmSync(join(dir, 'avatar.png'));
    symlinkSync(outside, join(dir, 'avatar.png'));
    writeFileSync(
      join(dir, 'profile.json'),
      JSON.stringify({ ...profile, avatar: { color: '#0ea5e9', imageVersion: 4 } })
    );
    expect(store.avatarPath()).toBeNull();
    expect(store.setAvatar(new Uint8Array([9]))?.avatar.imageVersion).toBe(5);
    expect(readFileSync(outside, 'utf8')).toBe('secret');
    expect(readFileSync(join(dir, 'avatar.png'))).toEqual(Buffer.from([9]));
    const saved = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')) as {
      avatar: Record<string, unknown>;
    };
    expect(saved.avatar).toMatchObject({ color: '#0ea5e9', imageVersion: 5 });
    expect(saved.avatar.imageHash).toMatch(/^[0-9a-f]{8}$/u);
    expect(JSON.stringify(saved)).not.toContain('base64');
    expect(saved.avatar).not.toHaveProperty('path');
    rmSync(outside, { force: true });
  });

  it('round-trips dispatch.json and normalizes it on write', () => {
    expect(store.dispatch()).toEqual({
      version: 1,
      dispatched: {},
      named: [],
      proposals: {},
      outbox: [],
    });

    const saved = store.saveDispatch({
      version: 1,
      dispatched: {
        c1: {
          conversationId: 'c1',
          projectId: 'p1',
          secretaryConversationId: 's1',
          createdAt: 10,
          turn: -1,
          lastState: 'running',
          lastEventAt: 20,
        },
      },
      named: ['c1'],
      proposals: {},
      outbox: [{ key: 'k', at: 1, text: '完成', kind: 'turn-ended', conversationId: 'c1' }],
      inflight: {
        deliveryId: 'd1',
        secretaryConversationId: 's1',
        keys: ['k'],
        attempt: 0,
        nextAttemptAt: 30,
      },
    });
    expect(saved.dispatched.c1?.turn).toBe(0);
    expect(saved.inflight?.attempt).toBe(1);
    expect(new SecretaryStore(dir, now).dispatch()).toEqual(saved);
  });

  it('keeps the untracked list on disk across restarts', () => {
    const saved = store.saveDispatch({
      version: 1,
      dispatched: {},
      named: [],
      untracked: ['c1', 'c2'],
      proposals: {},
      outbox: [],
    });
    expect(saved.untracked).toEqual(['c1', 'c2']);
    expect(new SecretaryStore(dir, now).dispatch().untracked).toEqual(['c1', 'c2']);
  });

  it('round-trips todos.json and schedules.json', () => {
    expect(store.todos()).toEqual([]);
    expect(store.schedules()).toEqual([]);

    const todos = [{ id: 't1', text: '写周报', createdAt: 1, updatedAt: 2 }];
    expect(store.saveTodos(todos)).toEqual(todos);
    expect(new SecretaryStore(dir, now).todos()).toEqual(todos);

    const schedules = [{ id: 's1', name: '日报', prompt: '总结', cron: '0 9 * * *', createdAt: 1 }];
    expect(store.saveSchedules(schedules)).toEqual(schedules);
    expect(new SecretaryStore(dir, now).schedules()).toEqual(schedules);
  });

  it('reads corrupt lists as empty', () => {
    writeFileSync(join(dir, 'todos.json'), '{"todos":[]}');
    writeFileSync(join(dir, 'schedules.json'), 'oops');
    expect(store.todos()).toEqual([]);
    expect(store.schedules()).toEqual([]);
  });
});
