import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RestartCheckpoint } from '@shared/gracefulRestart';
import { describe, expect, it } from 'vitest';
import {
  buildRestartManifest,
  findSecretLikeStrings,
  parseRestartManifest,
  pickRestartSettings,
  RESTART_MANIFEST_ARCHIVE,
  RESTART_MANIFEST_FILE,
  secretValuesOf,
  takeRestartManifest,
  writeRestartManifest,
} from './restartManifest';

const checkpoint: RestartCheckpoint = {
  version: 1,
  pid: 1,
  writtenAt: 1_000,
  sessions: [
    {
      sessionId: 's1',
      generation: 'g1',
      sessionFile: '/data/sessions/s1.jsonl',
      seq: 7,
      nextStep: 'model-request',
      turnId: 't1',
      lastCompletedToolCallId: 'call-1',
      messageCount: 4,
      toolsInFlight: [],
    },
    {
      sessionId: 'bot',
      generation: 'g2',
      sessionFile: '/data/sessions/bot.jsonl',
      seq: 2,
      nextStep: 'await-user',
      turnId: null,
      lastCompletedToolCallId: null,
      messageCount: 1,
      toolsInFlight: [],
    },
  ],
};
const tmp = () => mkdtempSync(path.join(tmpdir(), 'enso-restart-manifest-'));

describe('restartManifest', () => {
  it('会话设置按白名单复制，凭据样式的多余字段一律丢掉', () => {
    expect(
      pickRestartSettings({
        providerId: 'p',
        modelId: 'm',
        cwd: '/w',
        thinkingLevel: 'high',
        askRelay: { name: 'secretary', token: 'x' },
        apiKey: 'sk-should-not-survive-000000000',
        model: { apiKey: 'sk-nested-000000000000000000' },
      })
    ).toEqual({
      providerId: 'p',
      modelId: 'm',
      cwd: '/w',
      thinkingLevel: 'high',
      askRelay: { name: 'secretary' },
    });
    expect(pickRestartSettings({ modelId: 'm', cwd: '/w' })).toBeNull();
  });

  it('只给有设置的会话写条目，字段与断点一致；写盘、读回、只消费一次', () => {
    const dir = tmp();
    const manifest = buildRestartManifest({
      reason: 'quit',
      checkpoint,
      settingsOf: (id) => (id === 's1' ? { providerId: 'p', modelId: 'm', cwd: '/w' } : undefined),
      now: 2_000,
    });
    expect(manifest.sessions).toEqual([
      {
        sessionId: 's1',
        generation: 'g1',
        sessionFile: '/data/sessions/s1.jsonl',
        settings: { providerId: 'p', modelId: 'm', cwd: '/w' },
        turnId: 't1',
        nextStep: 'model-request',
        lastCompletedToolCallId: 'call-1',
        seq: 7,
      },
    ]);
    expect(writeRestartManifest(dir, manifest)).toBe(true);
    expect(takeRestartManifest(dir, 3_000)).toEqual(manifest);
    expect(existsSync(path.join(dir, RESTART_MANIFEST_FILE))).toBe(false);
    expect(existsSync(path.join(dir, RESTART_MANIFEST_ARCHIVE))).toBe(true);
    expect(takeRestartManifest(dir, 3_000)).toBeNull();
  });

  it('写盘后核对：命中密钥样式或 Main 内存里的真实凭据就删文件并报错', () => {
    const dir = tmp();
    const leaked = buildRestartManifest({
      reason: 'update',
      checkpoint,
      settingsOf: () => ({ providerId: 'p', modelId: 'm', cwd: '/w/sk-proj-abcdefghijklmnop0123' }),
    });
    expect(() => writeRestartManifest(dir, leaked)).toThrow(/credentials/);
    expect(existsSync(path.join(dir, RESTART_MANIFEST_FILE))).toBe(false);

    const custom = buildRestartManifest({
      reason: 'quit',
      checkpoint,
      settingsOf: () => ({ providerId: 'p', modelId: 'm', cwd: '/w/plain-secret-value' }),
    });
    expect(() => writeRestartManifest(dir, custom, ['plain-secret-value'])).toThrow(
      /known-credential/
    );
    expect(existsSync(path.join(dir, RESTART_MANIFEST_FILE))).toBe(false);
  });

  it('密钥样式识别与凭据收集', () => {
    for (const text of [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'Bearer abcdefghijklmnopqrstuvwxyz',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2',
      '{"refresh_token":"x"}',
      '{"apiKey":"x"}',
      '-----BEGIN RSA PRIVATE KEY-----',
    ]) {
      expect(findSecretLikeStrings(text), text).not.toEqual([]);
    }
    expect(findSecretLikeStrings('{"providerId":"openai","modelId":"gpt-5","cwd":"/w"}')).toEqual(
      []
    );
    expect(
      secretValuesOf({
        model: {
          apiKey: 'key-123456789',
          baseUrl: 'https://x',
          headers: { 'X-Org': 'org-12345678' },
        },
        remote: { password: 'hunter2hunter2' },
        cwd: '/workspace/long-path',
      }).sort()
    ).toEqual(['hunter2hunter2', 'key-123456789', 'org-12345678']);
  });

  it('坏清单、过期清单不恢复', () => {
    const good = buildRestartManifest({
      reason: 'quit',
      checkpoint,
      settingsOf: () => ({ providerId: 'p', modelId: 'm', cwd: '/w' }),
      now: 0,
    });
    expect(parseRestartManifest(good, 1)).toEqual(good);
    expect(parseRestartManifest(good, 25 * 60 * 60 * 1000)).toBeNull();
    expect(parseRestartManifest({ ...good, version: 2 }, 1)).toBeNull();
    expect(
      parseRestartManifest({ ...good, sessions: [{ ...good.sessions[0], seq: -1 }] }, 1)
    ).toBeNull();
    const dir = tmp();
    writeFileSync(path.join(dir, RESTART_MANIFEST_FILE), '{not json');
    expect(takeRestartManifest(dir)).toBeNull();
    expect(readFileSync(path.join(dir, RESTART_MANIFEST_ARCHIVE), 'utf8')).toBe('{not json');
  });
});
