import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildChildContextSeed,
  MAX_FILE_SLICE_CHARS,
  MAX_FORK_COMPACT_CHARS,
  MAX_PRIOR_READS_CHARS,
} from './childContextSeed';
import type { ContextMessage } from './imageContext';
import { ReadLedger } from './priorRead';

let root: string;
let cwd: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'enso-child-seed-'));
  cwd = path.join(root, 'repo');
  outside = path.join(root, 'outside');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readExchange(
  callId: string,
  filePath: string,
  content: string,
  extraArgs: Record<string, unknown> = {}
): ContextMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: callId,
          name: 'read',
          arguments: { path: filePath, ...extraArgs },
        },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'read',
      content: [{ type: 'text', text: content }],
    },
  ];
}

describe('buildChildContextSeed', () => {
  it('mode="none" 返回空种子与零统计', async () => {
    const file = path.join(cwd, 'a.ts');
    writeFileSync(file, 'export const a = 1;\n');
    const ledger = new ReadLedger(cwd);
    await ledger.record('a.ts');
    const seed = await buildChildContextSeed(
      [
        { role: 'user', content: 'check a.ts' },
        ...readExchange('c1', 'a.ts', 'export const a = 1;'),
      ],
      ledger,
      { mode: 'none', cwd, acceptsImages: true }
    );
    expect(seed.text).toBe('');
    expect(seed.images).toBeUndefined();
    expect(seed.stats).toEqual({
      mode: 'none',
      filesIncluded: 0,
      staleFilesSkipped: 0,
      userTurnsIncluded: 0,
      imagesIncluded: 0,
      chars: 0,
    });
  });

  it('prior_reads：同文件按 realpath 去重并合并相邻/重叠行段，最新读取排前', async () => {
    mkdirSync(path.join(cwd, 'src'), { recursive: true });
    writeFileSync(path.join(cwd, 'src', 'a.ts'), 'l1\nl2\nl3\nl4\n');
    writeFileSync(path.join(cwd, 'src', 'b.ts'), 'const b = 2;\n');
    const ledger = new ReadLedger(cwd);
    await ledger.record('src/a.ts');
    await ledger.record('src/b.ts');

    const messages: ContextMessage[] = [
      { role: 'user', content: 'Investigate a.ts and b.ts' },
      ...readExchange('r1', 'src/a.ts', 'l1\nl2', { offset: 1, limit: 2 }),
      ...readExchange('r2', './src/a.ts', 'l2\nl3\nl4', { offset: 2, limit: 3 }),
      ...readExchange('r3', 'src/b.ts', 'const b = 2;'),
    ];
    const seed = await buildChildContextSeed(messages, ledger, {
      mode: 'prior_reads',
      cwd,
      acceptsImages: true,
    });

    expect(seed.stats.filesIncluded).toBe(2);
    expect(seed.stats.staleFilesSkipped).toBe(0);
    expect(seed.text).toContain('<parent_context_seed mode="prior_reads">');
    expect(seed.text).toContain('</parent_context_seed>');
    // 最近读取的 b.ts 排在 a.ts 前面
    expect(seed.text.indexOf('src/b.ts')).toBeLessThan(seed.text.indexOf('src/a.ts'));
    // a.ts 两段重叠切片应合并为 L1-L4 且 l2 不重复
    expect(seed.text).toContain('#### src/a.ts (L1-L4)');
    expect(seed.text).toContain('l1\nl2\nl3\nl4');
    expect(seed.text).not.toContain('l2\nl2');
  });

  it('prior_reads：超过 30KB 预算与单文件 8KB 上限时确定性裁剪，优先保最近读取', async () => {
    const ledger = new ReadLedger(cwd);
    const messages: ContextMessage[] = [];
    for (let i = 0; i < 6; i++) {
      const name = `file-${i}.ts`;
      const bigBody = `// FILE_${i}_HEAD\n${'x'.repeat(MAX_FILE_SLICE_CHARS + 2000)}\n// FILE_${i}_TAIL`;
      writeFileSync(path.join(cwd, name), bigBody);
      await ledger.record(name);
      messages.push(...readExchange(`r-${i}`, name, bigBody));
    }

    const seed = await buildChildContextSeed(messages, ledger, {
      mode: 'prior_reads',
      cwd,
      acceptsImages: false,
    });

    expect(seed.text.length).toBeLessThanOrEqual(MAX_PRIOR_READS_CHARS);
    expect(seed.stats.chars).toBe(seed.text.length);
    // 最新的 file-5 必在其中，且单文件超 8KB 被截断
    expect(seed.text).toContain('file-5.ts');
    expect(seed.text).toContain('FILE_5_HEAD');
    expect(seed.text).not.toContain('FILE_5_TAIL');
    // 受总预算限制，最老的 file-0 已被裁掉
    expect(seed.text).not.toContain('file-0.ts');
    expect(seed.stats.filesIncluded).toBeLessThan(6);
  });

  it('prior_reads：磁盘修改、父会话写后未重读、文件删除均标 stale 且不塞旧正文', async () => {
    const editedExternally = path.join(cwd, 'ext.ts');
    const editedByParent = path.join(cwd, 'mut.ts');
    const reReadAfterEdit = path.join(cwd, 'fresh.ts');
    const deletedFile = path.join(cwd, 'gone.ts');
    writeFileSync(editedExternally, 'old external');
    writeFileSync(editedByParent, 'old parent');
    writeFileSync(reReadAfterEdit, 'v1');
    writeFileSync(deletedFile, 'bye');

    const ledger = new ReadLedger(cwd);
    await ledger.record('ext.ts');
    await ledger.record('mut.ts');
    await ledger.record('fresh.ts');
    await ledger.record('gone.ts');

    // 模拟外部进程修改 ext.ts，与 ReadLedger 记录失配
    writeFileSync(editedExternally, 'changed externally on disk');
    utimesSync(editedExternally, new Date(), new Date(Date.now() + 5000));
    // 模拟文件删除
    rmSync(deletedFile);
    // 模拟父会话编辑后更新了磁盘与账本
    writeFileSync(reReadAfterEdit, 'v2 fresh');
    await ledger.record('fresh.ts');

    const messages: ContextMessage[] = [
      ...readExchange('r1', 'ext.ts', 'OLD_EXTERNAL_CONTENT'),
      ...readExchange('r2', 'mut.ts', 'OLD_MUT_CONTENT'),
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'e1', name: 'edit', arguments: { path: 'mut.ts' } }],
      },
      {
        role: 'toolResult',
        toolCallId: 'e1',
        toolName: 'edit',
        content: [{ type: 'text', text: 'ok' }],
      },
      ...readExchange('r3', 'fresh.ts', 'OLD_V1_CONTENT'),
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'e2', name: 'write', arguments: { path: 'fresh.ts' } }],
      },
      {
        role: 'toolResult',
        toolCallId: 'e2',
        toolName: 'write',
        content: [{ type: 'text', text: 'ok' }],
      },
      ...readExchange('r4', 'fresh.ts', 'NEW_V2_CONTENT'),
      ...readExchange('r5', 'gone.ts', 'DELETED_CONTENT'),
    ];

    const seed = await buildChildContextSeed(messages, ledger, {
      mode: 'prior_reads',
      cwd,
      acceptsImages: false,
    });

    expect(seed.stats.filesIncluded).toBe(1);
    expect(seed.stats.staleFilesSkipped).toBe(3);
    expect(seed.text).toContain('NEW_V2_CONTENT');
    expect(seed.text).not.toContain('OLD_V1_CONTENT');
    expect(seed.text).not.toContain('OLD_EXTERNAL_CONTENT');
    expect(seed.text).not.toContain('OLD_MUT_CONTENT');
    expect(seed.text).not.toContain('DELETED_CONTENT');
    expect(seed.text).toContain(
      'ext.ts [modified on disk since parent read; re-read before editing]'
    );
    expect(seed.text).toContain(
      'mut.ts [modified on disk since parent read; re-read before editing]'
    );
    expect(seed.text).toContain(
      'gone.ts [modified on disk since parent read; re-read before editing]'
    );
  });

  it('prior_reads：严格过滤工作区越界路径、越界软链以及 .env / 密钥文件', async () => {
    const normal = path.join(cwd, 'ok.ts');
    const envFile = path.join(cwd, '.env');
    const pemFile = path.join(cwd, 'private.pem');
    const outsideFile = path.join(outside, 'secret-outside.txt');
    const escapeLink = path.join(cwd, 'escape.ts');
    const envLink = path.join(cwd, 'config.ts');

    writeFileSync(normal, 'export const safe = true;');
    writeFileSync(envFile, 'API_KEY=super-secret');
    writeFileSync(pemFile, '-----BEGIN PRIVATE KEY-----');
    writeFileSync(outsideFile, 'OUTSIDE_DATA');
    let hasSymlink = false;
    try {
      symlinkSync(outsideFile, escapeLink);
      symlinkSync(envFile, envLink);
      hasSymlink = true;
    } catch {
      // Windows 未开启开发者模式时无软链权限，其余边界与密钥用例照常执行
    }

    const ledger = new ReadLedger(cwd);
    for (const p of [
      'ok.ts',
      '.env',
      'private.pem',
      ...(hasSymlink ? ['escape.ts', 'config.ts'] : []),
    ]) {
      await ledger.record(p);
    }

    const messages: ContextMessage[] = [
      ...readExchange('r1', 'ok.ts', 'export const safe = true;'),
      ...readExchange('r2', '.env', 'API_KEY=super-secret'),
      ...readExchange('r3', 'private.pem', '-----BEGIN PRIVATE KEY-----'),
      ...readExchange('r4', '../outside/secret-outside.txt', 'OUTSIDE_DATA'),
      ...(hasSymlink
        ? [
            ...readExchange('r5', 'escape.ts', 'OUTSIDE_DATA'),
            ...readExchange('r6', 'config.ts', 'API_KEY=super-secret'),
          ]
        : []),
    ];

    const seed = await buildChildContextSeed(messages, ledger, {
      mode: 'prior_reads',
      cwd,
      acceptsImages: false,
    });

    expect(seed.stats.filesIncluded).toBe(1);
    expect(seed.text).toContain('export const safe = true;');
    expect(seed.text).not.toContain('super-secret');
    expect(seed.text).not.toContain('PRIVATE KEY');
    expect(seed.text).not.toContain('OUTSIDE_DATA');
    expect(seed.text).not.toContain('.env');
    expect(seed.text).not.toContain('private.pem');
  });

  it('prior_reads：提取最近 3 条用户约束（去重 spawnPrompt）与最近 2 轮用户贴图，非视觉模型降级占位', async () => {
    const img = (tag: string) => ({
      type: 'image',
      data: Buffer.from(tag).toString('base64'),
      mimeType: 'image/png',
    });
    const messages: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'turn 1 old' }, img('old-turn-1')] },
      { role: 'assistant', content: [{ type: 'text', text: 'ack 1' }] },
      { role: 'user', content: [{ type: 'text', text: 'turn 2 constraint' }, img('img-2a')] },
      { role: 'assistant', content: [{ type: 'text', text: 'ack 2' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'turn 3 duplicate in prompt' },
          img('img-3a'),
          img('img-3b'),
          img('img-3c'),
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ack 3' }] },
      {
        role: 'user',
        content: [{ type: 'text', text: 'turn 4 latest constraint' }, img('img-4a')],
      },
    ];

    // 支持图片的模型：只取最后 2 轮 user（turn 3 和 turn 4），且总量封顶 3 张（保留最新的 3 张）
    const visionSeed = await buildChildContextSeed(messages, undefined, {
      mode: 'prior_reads',
      cwd,
      acceptsImages: true,
      spawnPrompt: 'Please handle: turn 3 duplicate in prompt',
    });
    expect(visionSeed.stats.userTurnsIncluded).toBe(3);
    expect(visionSeed.text).toContain('turn 1 old');
    expect(visionSeed.text).toContain('turn 2 constraint');
    expect(visionSeed.text).toContain('turn 4 latest constraint');
    expect(visionSeed.text).not.toContain('turn 3 duplicate in prompt');
    expect(visionSeed.images).toHaveLength(3);
    expect(visionSeed.stats.imagesIncluded).toBe(3);
    expect(visionSeed.images?.map((i) => Buffer.from(i.data, 'base64').toString())).toEqual([
      'img-3b',
      'img-3c',
      'img-4a',
    ]);
    // 超限被丢弃的 img-3a 降级为占位说明，不静默消失
    expect(visionSeed.text).toContain('exceeded seed image count limit');

    // 不支持图片的模型：不附带任何 image 块，全部降级为 imagePlaceholder 文本占位
    const textOnlySeed = await buildChildContextSeed(messages, undefined, {
      mode: 'prior_reads',
      cwd,
      acceptsImages: false,
    });
    expect(textOnlySeed.images).toBeUndefined();
    expect(textOnlySeed.stats.imagesIncluded).toBe(0);
    expect(textOnlySeed.text).toContain('[image omitted from context: image/png');
    expect(textOnlySeed.text).toContain('does not accept image input');

    // 超出单图 base64 大小预算的图片也降级为文本占位
    const sizeCappedSeed = await buildChildContextSeed(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'big screenshot' },
            { type: 'image', data: 'A'.repeat(200), mimeType: 'image/png' },
          ],
        },
      ],
      undefined,
      { mode: 'prior_reads', cwd, acceptsImages: true, maxImageBase64Chars: 64 }
    );
    expect(sizeCappedSeed.images).toBeUndefined();
    expect(sizeCappedSeed.text).toContain('exceeded seed size budget');
  });

  it('fork_compact：彻底剥离厂商 thinking/signature，清理孤儿 toolResult，严守 24KB 预算', async () => {
    const file = path.join(cwd, 'core.ts');
    writeFileSync(file, 'export function run() { return 42; }\n');
    const ledger = new ReadLedger(cwd);
    await ledger.record('core.ts');

    const messages: ContextMessage[] = [
      { role: 'user', content: 'Fix the cross-model handoff bug without breaking cache.' },
      // 模拟 Gemini / Anthropic / OpenAI 混合厂商私有块
      {
        role: 'assistant',
        thoughtSignature: 'gemini-top-level-sig',
        providerMetadata: { vendor: 'google', opaque: 'secret-blob' },
        content: [
          {
            type: 'thinking',
            thinking: 'PRIVATE_CHAIN_OF_THOUGHT_MUST_NOT_LEAK',
            thinkingSignature: 'sig-anthropic-abc123',
            thoughtSignature: 'sig-gemini-xyz789',
          },
          { type: 'redacted_thinking', data: 'REDACTED_OPAQUE_DATA' },
          { type: 'text', text: 'I will inspect core.ts and verify the failing branch.' },
          {
            type: 'toolCall',
            id: 'call-read-1',
            name: 'read',
            arguments: { path: 'core.ts' },
            thoughtSignature: 'tool-call-sig-999',
          },
          {
            type: 'toolCall',
            id: 'call-secret-1',
            name: 'read',
            arguments: { path: '.env' },
          },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-read-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'export function run() { return 42; }' }],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-secret-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'TOP_SECRET_TOKEN=leaked' }],
      },
      // 孤儿 toolResult（对应一个不存在的 callId），必须被 sanitizeContextMessages 清除
      {
        role: 'toolResult',
        toolCallId: 'orphan-call-999',
        toolName: 'bash',
        content: [{ type: 'text', text: 'ORPHAN_OUTPUT_MUST_DROP' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Root cause confirmed: do not replay raw messages across providers.',
          },
        ],
      },
    ];

    const seed = await buildChildContextSeed(messages, ledger, {
      mode: 'fork_compact',
      cwd,
      acceptsImages: false,
    });

    expect(seed.text.length).toBeLessThanOrEqual(MAX_FORK_COMPACT_CHARS);
    expect(seed.text).toContain('<parent_context_seed mode="fork_compact">');
    expect(seed.text).toContain('### Compacted Parent Conversation');
    expect(seed.text).toContain('Fix the cross-model handoff bug without breaking cache.');
    expect(seed.text).toContain(
      'Root cause confirmed: do not replay raw messages across providers.'
    );
    expect(seed.text).toContain('export function run() { return 42; }');
    expect(seed.stats.filesIncluded).toBe(1);
    expect(seed.stats.userTurnsIncluded).toBe(1);

    // 严禁包含任何厂商私有字段、thinking 正文、孤儿输出或密钥文件内容
    for (const forbidden of [
      'PRIVATE_CHAIN_OF_THOUGHT_MUST_NOT_LEAK',
      'sig-anthropic-abc123',
      'sig-gemini-xyz789',
      'gemini-top-level-sig',
      'tool-call-sig-999',
      'REDACTED_OPAQUE_DATA',
      'providerMetadata',
      'ORPHAN_OUTPUT_MUST_DROP',
      'TOP_SECRET_TOKEN',
    ]) {
      expect(seed.text).not.toContain(forbidden);
    }
  });

  it('fork_compact：审批底线会拦的密钥读取（bash 点名密钥、grep glob 点名密钥）结果不转交子代理', async () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: 'Check the deploy config.' },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'cat .env.local' } },
          {
            type: 'toolCall',
            id: 'g1',
            name: 'grep',
            arguments: { pattern: 'KEY', path: '.', glob: '.env*' },
          },
          { type: 'toolCall', id: 'b2', name: 'bash', arguments: { command: 'git status' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'b1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'BASH_SECRET_VALUE=1' }],
      },
      {
        role: 'toolResult',
        toolCallId: 'g1',
        toolName: 'grep',
        content: [{ type: 'text', text: '.env:1:GREP_SECRET_VALUE=2' }],
      },
      {
        role: 'toolResult',
        toolCallId: 'b2',
        toolName: 'bash',
        content: [{ type: 'text', text: 'nothing to commit' }],
      },
    ];

    const seed = await buildChildContextSeed(messages, undefined, {
      mode: 'fork_compact',
      cwd,
      acceptsImages: false,
    });

    expect(seed.text).toContain('nothing to commit');
    expect(seed.text).not.toContain('BASH_SECRET_VALUE');
    expect(seed.text).not.toContain('GREP_SECRET_VALUE');
  });
});
