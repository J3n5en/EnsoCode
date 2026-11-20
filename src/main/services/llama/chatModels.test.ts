import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chatModelDirName,
  chatModelIdFromSettings,
  DEFAULT_CHAT_MODEL_ID,
  listChatModelSpecs,
  localChatModelPathIfReady,
  REMOTE_CHAT_MODEL_ID,
  resolveChatModelFile,
  resolveChatModelSpec,
} from './chatModels';

describe('chat model registry', () => {
  it('registers Gemma-4 E2B as a downloadable GGUF with HF-verified size', () => {
    const spec = resolveChatModelSpec('local:gemma-4-e2b');
    expect(spec).not.toBeNull();
    expect(spec?.files).toEqual([
      expect.objectContaining({ name: 'gemma-4-E2B-it-UD-Q4_K_XL.gguf' }),
    ]);
    expect(spec?.sources?.huggingface).toBe('unsloth/gemma-4-E2B-it-GGUF');
    // HF tree API 核对（2026-09-10）：3184496736 字节
    expect(spec?.approxBytes).toBe(3_184_496_736);
    expect(spec?.sources?.modelscope).toBeTruthy();
  });

  it('lists models from data, not by branching on id', () => {
    const ids = listChatModelSpecs().map((s) => s.id);
    expect(ids).toContain('local:gemma-4-e2b');
    expect(ids).toContain(REMOTE_CHAT_MODEL_ID);
  });

  it('unknown ids resolve to null', () => {
    expect(resolveChatModelSpec('local:does-not-exist')).toBeNull();
    expect(resolveChatModelSpec('')).toBeNull();
  });

  it('sanitizes cache directory names so Windows can store the id', () => {
    const spec = resolveChatModelSpec('local:gemma-4-e2b');
    expect(spec).not.toBeNull();
    expect(chatModelDirName(spec!)).toBe('local_gemma-4-e2b');
    expect(chatModelDirName(spec!)).not.toContain(':');
  });
});

describe('registry data integrity', () => {
  const downloadable = () => listChatModelSpecs().filter((s) => s.files.length > 0);

  it('pins every weight file by sha256', () => {
    // 量化权重来自第三方仓库；不校验就等于信任 CDN 返回的任何字节
    for (const spec of downloadable()) {
      for (const file of spec.files) {
        expect(file.sha256, `${spec.id}/${file.name}`).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('gives every downloadable model a ModelScope fallback', () => {
    // 中国区拿不到 HF；只有单一来源等于那部分用户完全不可用
    for (const spec of downloadable()) {
      expect(spec.sources?.modelscope, spec.id).toBeTruthy();
    }
  });

  it('loads the first file, so it must be the gguf weight', () => {
    // resolveChatModelFile 取 files[0]；顺序错了会去加载配置文件
    for (const spec of downloadable()) {
      expect(spec.files[0].name, spec.id).toMatch(/\.gguf$/);
    }
  });

  it('offers a real size gradient rather than one huge option', () => {
    // 3GB 会把只想试试的人挡在门外
    const sizes = downloadable().map((s) => s.approxBytes);
    expect(Math.min(...sizes)).toBeLessThan(1_000_000_000);
    expect(sizes.every((b) => b > 0)).toBe(true);
  });

  it('keeps chat ids distinct from embedding ids', () => {
    // 两套注册表都用 local: 前缀；同名会让模型目录互相覆盖
    expect(listChatModelSpecs().map((s) => s.id)).not.toContain('local:qwen3-0.6b');
  });
});

describe('chatModelIdFromSettings', () => {
  it('defaults to remote when the setting is missing or unknown', () => {
    expect(chatModelIdFromSettings(undefined)).toBe(DEFAULT_CHAT_MODEL_ID);
    expect(chatModelIdFromSettings({})).toBe(REMOTE_CHAT_MODEL_ID);
    expect(chatModelIdFromSettings({ memoryChatModel: 1 })).toBe(REMOTE_CHAT_MODEL_ID);
    expect(chatModelIdFromSettings({ memoryChatModel: 'local:nope' })).toBe(REMOTE_CHAT_MODEL_ID);
  });

  it('keeps a known local id', () => {
    expect(chatModelIdFromSettings({ memoryChatModel: 'local:gemma-4-e2b' })).toBe(
      'local:gemma-4-e2b'
    );
  });

  it('falls back when a removed model id is still persisted', () => {
    expect(chatModelIdFromSettings({ memoryChatModel: 'local:myvoicetyping-1.5b' })).toBe(
      REMOTE_CHAT_MODEL_ID
    );
  });
});

describe('resolveChatModelFile', () => {
  it('derives a path under modelsRoot from an identifier, never from a renderer path', () => {
    const root = '/user-data/memory/chat-models';
    const resolved = resolveChatModelFile(root, 'local:gemma-4-e2b');
    expect(resolved).toBe(path.join(root, 'local_gemma-4-e2b', 'gemma-4-E2B-it-UD-Q4_K_XL.gguf'));
    expect(path.resolve(resolved!).startsWith(path.resolve(root) + path.sep)).toBe(true);
  });

  it('refuses unknown ids and the remote sentinel so Main never builds a stray path', () => {
    expect(resolveChatModelFile('/models', 'remote')).toBeNull();
    expect(resolveChatModelFile('/models', '../etc/passwd')).toBeNull();
    expect(resolveChatModelFile('/models', 'local:gemma-4-e2b/../../secret')).toBeNull();
  });
});

describe('localChatModelPathIfReady', () => {
  it('returns null until the downloader ready marker and GGUF are both present', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enso-chat-model-'));
    expect(localChatModelPathIfReady(root, 'local:gemma-4-e2b')).toBeNull();

    const dir = path.join(root, 'local_gemma-4-e2b');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'gemma-4-E2B-it-UD-Q4_K_XL.gguf'), 'not-ready-yet');
    expect(localChatModelPathIfReady(root, 'local:gemma-4-e2b')).toBeNull();

    writeFileSync(path.join(dir, '.ready'), '');
    expect(localChatModelPathIfReady(root, 'local:gemma-4-e2b')).toBe(
      path.join(dir, 'gemma-4-E2B-it-UD-Q4_K_XL.gguf')
    );
  });
});
