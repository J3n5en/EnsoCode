import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEDUP_MIN_CHARS,
  DISTILL_CONSOLIDATE_MAX_TOKENS,
  DISTILL_EXTRACT_MAX_TOKENS,
  DISTILL_MAX_ATTEMPTS,
  DISTILL_MAX_OUTPUT_TOKENS,
  DISTILL_SINGLE_EXTRACT_MAX_TOKENS,
} from '@shared/memory/constants';
import { DISTILL_THREAD_PROMPT } from '@shared/memory/prompts';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from './db';
import {
  buildTranscript,
  chunkTranscript,
  DISTILL_MAX_CHUNK_CHARS,
  type DistilledMemory,
  distillFingerprint,
  distillTranscript,
  ensureDistillJob,
  listDistillJobs,
  listResumableDistillJobs,
  parseDistillOutput,
  redactSecrets,
  runDistillJob,
  toCreateInput,
} from './distill';
import { createMemory, listMemories } from './store';
import type { Embedder } from './types';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'enso-memory-distill-'));
  db = openMemoryDb(path.join(dir, 'memory.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const rows = () =>
  db
    .prepare('SELECT content, source, unit_type, unit_type_source FROM memories ORDER BY rowid')
    .all() as { content: string; source: string; unit_type: string; unit_type_source: string }[];
const mem = (over: Partial<DistilledMemory> = {}): DistilledMemory => ({
  title: 'Use PostgreSQL',
  content: 'We chose PostgreSQL as the primary database because the team knows it well.',
  importance: 0.8,
  confidence: 0.9,
  unitType: 'decision',
  temporal: null,
  ...over,
});
const json = (memories: DistilledMemory[]) =>
  JSON.stringify({
    memories: memories.map((m) => ({
      title: m.title,
      content: m.content,
      importance: m.importance,
      confidence: m.confidence,
      unit_type: m.unitType,
      temporal: m.temporal ? { type: 'exact', start: m.temporal.start, end: m.temporal.end } : null,
    })),
    summary: 's',
  });

describe('redactSecrets（蒸馏前的安全边界）', () => {
  it('常见密钥形态全部打码，普通文本与键名保留', () => {
    const input = [
      'OPENAI key sk-abcdefghijklmnopqrstuvwxyz123456 and github ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
      'aws AKIAIOSFODNN7EXAMPLE jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      'password=Sup3rS3cret! api_key: "AbCdEf123456" DB_URL=postgres://user:pa55word@host/db',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----',
      'stripe sk_live_51HqABCDEFGHIJKLMNOP hf hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 pat github_pat_11AAAAAAA0bbbbbbbbbbbbbbbbbbbbbbb',
      'We decided to use PostgreSQL; version 16.2 on port 5432.',
    ].join('\n');
    const out = redactSecrets(input);
    for (const secret of [
      'sk-abcdefghijklmnopqrstuvwxyz123456',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
      'AKIAIOSFODNN7EXAMPLE',
      'eyJhbGciOiJIUzI1NiJ9',
      'abcdefghijklmnopqrstuvwxyz0123456789',
      'Sup3rS3cret!',
      'AbCdEf123456',
      'pa55word',
      'MIIEow',
      'sk_live_51HqABCDEFGHIJKLMNOP',
      'hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ12',
      'github_pat_11AAAAAAA0bbbbbbbbbbbbbbbbbbbbbbb',
    ]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('password=');
    expect(out).toContain('api_key:');
    expect(out).toContain('We decided to use PostgreSQL; version 16.2 on port 5432.');
    expect(out).toContain('postgres://');
  });
  it.each([{ token: false }, { auth: { token: null } }])(
    '非秘密 JSON 值 %j 保持原样且保留闭合结构',
    (config) => {
      const text = JSON.stringify(config);
      const redacted = redactSecrets(text);
      expect(redacted).toBe(text);
      expect(JSON.parse(redacted)).toEqual(config);
    }
  );
});

describe('buildTranscript / chunkTranscript（分块）', () => {
  it('按 User/Assistant 标注拼接并先打码；空消息跳过', () => {
    const t = buildTranscript([
      { role: 'user', text: 'token=sk-abcdefghijklmnopqrstuvwxyz123456 please' },
      { role: 'assistant', text: '   ' },
      { role: 'assistant', text: 'ok' },
    ]);
    expect(t).toBe('User: token=[REDACTED] please\n\nAssistant: ok');
  });

  it('不超过上限时单块；超长按消息边界切，每块 ≤ 上限，内容无损；单条超长消息硬切', () => {
    const short = buildTranscript([{ role: 'user', text: 'hi' }]);
    expect(chunkTranscript(short)).toEqual([short]);
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      text: `message ${i} ${'x'.repeat(300)}`,
    }));
    const t = buildTranscript(messages);
    const chunks = chunkTranscript(t);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(DISTILL_MAX_CHUNK_CHARS);
      // 每块都从消息边界开始
      expect(c).toMatch(/^(User|Assistant): /);
    }
    expect(chunks.join('\n\n')).toBe(t);
    const huge = buildTranscript([{ role: 'user', text: 'y'.repeat(9000) }]);
    const hard = chunkTranscript(huge);
    expect(hard.length).toBe(3);
    expect(hard.join('')).toBe(huge);
  });
});

describe('parseDistillOutput（容错 JSON）', () => {
  it('代码围栏 / 前后废话 / 尾逗号 / 截断 都能解析；完全垃圾返回空', () => {
    const one = mem();
    expect(
      parseDistillOutput(`Sure! Here you go:\n\`\`\`json\n${json([one])}\n\`\`\`\nHope it helps`)
    ).toEqual([one]);
    const trailing = `{"memories":[{"title":"t","content":"c","importance":0.7,"confidence":0.5,"unit_type":"fact","temporal":null,},],"summary":"s",}`;
    expect(parseDistillOutput(trailing)).toEqual([
      {
        title: 't',
        content: 'c',
        importance: 0.7,
        confidence: 0.5,
        unitType: 'fact',
        temporal: null,
      },
    ]);
    const truncated = `{"memories":[{"title":"t","content":"c","importance":0.7,"confidence":0.5,"unit_type":"fact","temporal":null},{"title":"u","content":"long text that got cut`;
    expect(parseDistillOutput(truncated)).toEqual([]);
    expect(parseDistillOutput('I could not find anything durable.')).toEqual([]);
    expect(parseDistillOutput('')).toEqual([]);
    // 缺 importance / content 非字符串的条目丢弃，不影响其余
    expect(
      parseDistillOutput(
        '{"memories":[{"title":"a","content":42,"importance":0.9},{"content":"ok","importance":"0.8"}]}'
      )
    ).toEqual([
      {
        title: null,
        content: 'ok',
        importance: 0.8,
        confidence: null,
        unitType: null,
        temporal: null,
      },
    ]);
  });
});

describe('toCreateInput（写入映射）', () => {
  it('importance<0.5 丢弃；非法 unit_type 回退 fact+fallback；日期走 normalizeTemporalDate，非法丢弃', () => {
    expect(toCreateInput(mem({ importance: 0.49 }), 'global')).toBeNull();
    expect(toCreateInput(mem({ content: '   ' }), 'global')).toBeNull();
    const valid = toCreateInput(mem(), 'global');
    expect(valid).toMatchObject({
      source: 'distill',
      unitType: 'decision',
      unitTypeSource: 'explicit',
      importance: 0.8,
      confidence: 0.9,
      spaceId: 'global',
      eventStart: null,
    });
    expect(toCreateInput(mem({ unitType: 'vibe' }), 'global')).toMatchObject({
      unitType: 'fact',
      unitTypeSource: 'fallback',
    });
    // 没给 unit_type 不自作主张：留空让 createMemory 走分类器 / default
    const noType = toCreateInput(mem({ unitType: null }), 'global');
    expect(noType?.unitType).toBeNull();
    expect(noType?.unitTypeSource).toBeUndefined();
    expect(
      toCreateInput(mem({ temporal: { start: '2024-03', end: '2024-05' } }), 'global')
    ).toMatchObject({ eventStart: '2024-03', eventEnd: '2024-05' });
    expect(
      toCreateInput(mem({ temporal: { start: 'yesterday', end: null } }), 'global')
    ).toMatchObject({ eventStart: null, eventEnd: null });
    // importance 超界夹住
    expect(toCreateInput(mem({ importance: 7 }), 'global')?.importance).toBe(1);
  });
});

describe('distillFingerprint 迁移兼容', () => {
  it('存量任务（无 language）沿用旧算法，带 language 的是另一个指纹', () => {
    const legacy = distillFingerprint('s1', 'hello');
    // 语言功能上线前的任务就是这么算的；改了算法它们会全部被判成「原文已变」
    expect(legacy).toBe(`s1#${createHash('sha256').update('hello', 'utf8').digest('hex')}`);
    expect(distillFingerprint('s1', 'hello', 'en')).not.toBe(legacy);
    expect(distillFingerprint('s1', 'hello', 'zh')).not.toBe(
      distillFingerprint('s1', 'hello', 'en')
    );
  });
});

describe('distillTranscript（小/大线程路由）', () => {
  it('小线程：一次调用，system 为 DISTILL_THREAD_PROMPT 原文，并使用抽取输出预算', async () => {
    const calls: { system: string; user: string; maxTokens?: number; stage?: string }[] = [];
    const out = await distillTranscript('User: use pg', async (system, user, options) => {
      calls.push({ system, user, ...options });
      return json([mem()]);
    });
    expect(calls).toHaveLength(1);
    // 提示词原文不变，语言规则只能追加在后（缺省英文）
    expect(calls[0].system).toContain(DISTILL_THREAD_PROMPT);
    expect(calls[0].system).toContain('in English');
    expect(calls[0]).toMatchObject({
      user: 'User: use pg',
      maxTokens: DISTILL_SINGLE_EXTRACT_MAX_TOKENS,
      stage: 'extract',
    });
    expect(out).toEqual([mem()]);
  });

  it('大线程：按块调用 distillChunkPrompt；块结果 >3 条时再走合并，≤3 条不合并', async () => {
    const t = buildTranscript(
      Array.from({ length: 30 }, (_, i) => ({
        role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
        text: `m${i} ${'x'.repeat(300)}`,
      }))
    );
    const chunks = chunkTranscript(t);
    const calls: { user: string; maxTokens?: number; stage?: string }[] = [];
    const out = await distillTranscript(t, async (_system, user, options) => {
      calls.push({ user, ...options });
      if (user.startsWith('Consolidate these')) return json([mem({ title: 'merged' })]);
      const n = Number(/CHUNK (\d+)\//.exec(user)?.[1]);
      return json([mem({ title: `c${n}a` }), mem({ title: `c${n}b` })]);
    });
    expect(calls.filter(({ user }) => /^Extract 0-3 key memories/.test(user))).toHaveLength(
      chunks.length
    );
    expect(calls.filter(({ user }) => user.startsWith('Consolidate these'))).toHaveLength(1);
    expect(
      calls
        .filter(({ stage }) => stage === 'extract')
        .every(({ maxTokens }) => maxTokens === DISTILL_EXTRACT_MAX_TOKENS)
    ).toBe(true);
    expect(calls.find(({ stage }) => stage === 'consolidate')?.maxTokens).toBe(
      DISTILL_CONSOLIDATE_MAX_TOKENS
    );
    expect(out.map((m) => m.title)).toEqual(['merged']);
    // 每个块提示词都带 CHUNK i/N
    for (const [i] of chunks.entries())
      expect(calls[i].user).toContain(`CHUNK ${i + 1}/${chunks.length}`);

    const few = await distillTranscript(t, async (_s, user) =>
      /CHUNK 1\//.test(user) ? json([mem({ title: 'only' })]) : json([])
    );
    expect(few.map((m) => m.title)).toEqual(['only']);
  });

  it('截断输出在同轮提高到硬上限重试一次，仍截断则拒绝', async () => {
    const budgets: number[] = [];
    const truncated = '{"memories":[{"title":"x","content":"cut';
    const recovered = await distillTranscript('User: use pg', async (_system, _user, options) => {
      budgets.push(options?.maxTokens ?? 0);
      return budgets.length === 1 ? truncated : json([mem()]);
    });
    expect(budgets).toEqual([DISTILL_SINGLE_EXTRACT_MAX_TOKENS, DISTILL_MAX_OUTPUT_TOKENS]);
    expect(recovered).toEqual([mem()]);

    let calls = 0;
    await expect(
      distillTranscript('User: use pg', async () => {
        calls++;
        return truncated;
      })
    ).rejects.toThrow(/incomplete JSON/);
    expect(calls).toBe(2);

    calls = 0;
    await expect(
      distillTranscript(
        'User: use pg',
        async (_system, _user, options) => {
          calls++;
          expect(options?.maxTokens).toBe(DISTILL_MAX_OUTPUT_TOKENS);
          return truncated;
        },
        { extractMaxTokens: DISTILL_MAX_OUTPUT_TOKENS }
      )
    ).rejects.toThrow(/incomplete JSON/);
    expect(calls).toBe(1);
  });

  it('分块路径每个截断块各自升到硬上限，不丢弃后续截断块', async () => {
    const transcript = `User: ${'x'.repeat(20)}`;
    const seen = new Map<string, number>();
    const budgets: number[] = [];
    const chunks = chunkTranscript(transcript, 10);
    const out = await distillTranscript(
      transcript,
      async (_system, user, options) => {
        budgets.push(options?.maxTokens ?? 0);
        const count = (seen.get(user) ?? 0) + 1;
        seen.set(user, count);
        return count === 1 ? '{"memories":[{"content":"cut' : json([mem({ title: user })]);
      },
      { maxChunkChars: 10 }
    );
    expect(out).toHaveLength(chunks.length);
    expect(budgets.filter((budget) => budget === DISTILL_MAX_OUTPUT_TOKENS)).toHaveLength(
      chunks.length
    );
  });

  it('分块提取在单块达到硬上限仍截断时整轮拒绝', async () => {
    const transcript = `User: ${'x'.repeat(20)}`;
    const truncated = '{"memories":[{"content":"cut';
    let calls = 0;
    await expect(
      distillTranscript(
        transcript,
        async (_system, user) => {
          calls++;
          return /CHUNK 1\//.test(user) ? truncated : json([mem()]);
        },
        { maxChunkChars: 10 }
      )
    ).rejects.toMatchObject({ name: 'DistillTruncatedError' });
    expect(calls).toBe(2);
  });

  it('合并截断时保留完整分块结果并回退到重要度前三', async () => {
    const transcript = `User: ${'x'.repeat(20)}`;
    const out = await distillTranscript(
      transcript,
      async (_system, user) => {
        if (user.startsWith('Consolidate these')) return '{"memories":[{"title":"x","content":"cut';
        const chunk = Number(/CHUNK (\d+)\//.exec(user)?.[1]);
        return json([mem({ title: `chunk-${chunk}`, importance: chunk / 10 })]);
      },
      { maxChunkChars: 7 }
    );
    expect(out.map((memory) => memory.title)).toEqual(['chunk-4', 'chunk-3', 'chunk-2']);
  });

  it('单块失败不拖垮整体，全部失败抛出', async () => {
    const t = buildTranscript(
      Array.from({ length: 30 }, (_, i) => ({
        role: 'user' as const,
        text: `m${i} ${'x'.repeat(300)}`,
      }))
    );
    const out = await distillTranscript(t, async (_s, user) => {
      if (/CHUNK 1\//.test(user)) throw new Error('boom');
      return json([mem({ title: 'ok' })]);
    });
    expect(out.length).toBeGreaterThan(0);
    await expect(
      distillTranscript('User: x', async () => {
        throw new Error('down');
      })
    ).rejects.toThrow('down');
  });
});

describe('蒸馏任务（memory_jobs kind=distill）', () => {
  const payload = { sessionId: 's1', sessionFile: '/tmp/s1.jsonl', projectId: null };
  const transcript = buildTranscript([
    { role: 'user', text: 'which db?' },
    { role: 'assistant', text: 'PostgreSQL, team knows it.' },
  ]);

  it.each(['"', "'"])(
    '引号 %s 配置与自由文本密钥在 complete 前打码，保留非敏感配置',
    async (quote) => {
      const text = `Production config: {${quote}password${quote}:${quote}secret${quote},${quote}apiKey${quote}:${quote}generic_token${quote},${quote}port${quote}:5432} password=Sup3rS3cret!`;
      const safe = `Production config: {${quote}password${quote}:${quote}[REDACTED]${quote},${quote}apiKey${quote}:${quote}[REDACTED]${quote},${quote}port${quote}:5432} password=[REDACTED]`;
      const transcript = buildTranscript([{ role: 'user', text }]);
      const job = ensureDistillJob(db, payload, distillFingerprint('s1', transcript))!;
      const sent: string[] = [];
      const done = await runDistillJob(db, job, {
        transcript,
        complete: async (_system, user) => {
          sent.push(user);
          return json([mem()]);
        },
      });
      expect(done).toMatchObject({ status: 'done', done: 1 });
      expect(sent).toEqual([`User: ${safe}`]);
      expect(listMemories(db, { spaceIds: ['global'] })).toHaveLength(1);
    }
  );

  it.each(
    ['"', "'"].flatMap((quote) =>
      [
        'short secret',
        'secret phrase',
        'short,secret',
        'secret"suffix',
        "secret'suffix",
        'secret\\suffix',
        'tiny',
      ].map((secret) => [quote, secret])
    )
  )('引号 %s 密钥 %s 在输入、合并及落库时整体替换且保留配置结构', async (quote, secret) => {
    const escaped = secret.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`);
    const config = `{${quote}password${quote}:${quote}${escaped}${quote},${quote}port${quote}:5432}`;
    const safe = `{${quote}password${quote}:${quote}[REDACTED]${quote},${quote}port${quote}:5432}`;
    const transcript = buildTranscript([
      { role: 'user', text: config },
      { role: 'assistant', text: 'x'.repeat(DISTILL_MAX_CHUNK_CHARS * 2) },
    ]);
    const job = ensureDistillJob(db, payload, distillFingerprint('s1', transcript))!;
    const sent: string[] = [];
    const done = await runDistillJob(db, job, {
      transcript,
      complete: async (_system, user) => {
        sent.push(user);
        const output = mem({ content: config, title: config });
        return user.startsWith('Consolidate these') ? json([output]) : json([output, output]);
      },
    });
    expect(done).toMatchObject({ status: 'done', done: 1 });
    const inputConfig = sent[0].split('User: ')[1].split('\n')[0];
    expect(inputConfig).toBe(safe);
    const consolidation = sent.filter((user) => user.startsWith('Consolidate these'));
    expect(consolidation).toHaveLength(1);
    expect(consolidation[0]).toContain(safe);
    expect(consolidation[0]).not.toContain(config);
    const stored = listMemories(db, { spaceIds: ['global'] });
    expect(stored).toEqual([expect.objectContaining({ content: safe, title: safe })]);
    if (quote === '"') {
      expect(JSON.parse(inputConfig)).toEqual({ password: '[REDACTED]', port: 5432 });
      expect(JSON.parse(stored[0].content)).toEqual({ password: '[REDACTED]', port: 5432 });
    }
  });

  it('模型输出中的密钥在正文、标题和被丢弃条目的任务 notes 落库前打码', async () => {
    const content = 'Keep port 5432; {"password":"secret","apiKey":"generic_token"}';
    const title = "Config {'client_secret':'title_secret'}";
    const job = ensureDistillJob(db, payload, distillFingerprint('s1', transcript))!;
    const done = await runDistillJob(db, job, {
      transcript,
      complete: async () =>
        json([
          mem({ content, title }),
          mem({ content: 'password=discarded_secret', title: null, importance: 0.2 }),
        ]),
    });
    expect(done).toMatchObject({ status: 'done', done: 1, failed: 1 });
    expect(listMemories(db, { spaceIds: ['global'] })).toEqual([
      expect.objectContaining({
        content: 'Keep port 5432; {"password":"[REDACTED]","apiKey":"[REDACTED]"}',
        title: "Config {'client_secret':'[REDACTED]'}",
      }),
    ]);
    expect(listDistillJobs(db)[0].notes).toEqual([
      expect.objectContaining({ title: 'password=[REDACTED]' }),
    ]);
  });

  it('分块输出的密钥不能进入合并 complete，合并结果也须打码后落库', async () => {
    const transcript = buildTranscript([
      { role: 'user', text: 'x'.repeat(DISTILL_MAX_CHUNK_CHARS * 2) },
    ]);
    const job = ensureDistillJob(db, payload, distillFingerprint('s1', transcript))!;
    const sent: string[] = [];
    const done = await runDistillJob(db, job, {
      transcript,
      complete: async (_system, user) => {
        sent.push(user);
        return user.startsWith('Consolidate these')
          ? json([mem({ content: 'Config {"apiKey":"[REDACTED]"}' })])
          : json([
              mem({ content: 'Config {"apiKey":"chunk_secret"}' }),
              mem({ title: 'password=chunk_title_secret' }),
            ]);
      },
    });
    expect(done).toMatchObject({ status: 'done', done: 1 });
    const consolidation = sent.filter((user) => user.startsWith('Consolidate these'));
    expect(consolidation).toHaveLength(1);
    expect(consolidation[0]).not.toContain('chunk_secret');
    expect(consolidation[0]).not.toContain('chunk_title_secret');
    expect(consolidation[0]).toContain('Config {"apiKey":"[REDACTED]"}');
    expect(rows()[0].content).toBe('Config {"apiKey":"[REDACTED]"}');
  });

  it.each([
    ['2024', null, '2024-01-01', null, 'year'],
    ['2024-03', '2024-05', '2024-03-01', '2024-05-01', 'month'],
    ['2024-03-15', null, '2024-03-15', null, 'day'],
  ])(
    '提炼日期 %s 与直接 capture 保持相同日期和精度',
    async (start, end, date, endDate, precision) => {
      const direct = await createMemory(db, {
        content: 'Direct capture of the migration plan.',
        spaceId: 'global',
        eventStart: start,
        eventEnd: end,
      });
      expect(direct.status).toBe('inserted');
      const job = ensureDistillJob(db, payload, distillFingerprint('s1', transcript))!;
      const done = await runDistillJob(db, job, {
        transcript,
        complete: async () => json([mem({ temporal: { start, end } })]),
      });
      expect(done).toMatchObject({ status: 'done', done: 1 });
      const stored = listMemories(db, { spaceIds: ['global'] });
      expect(stored).toHaveLength(2);
      for (const memory of stored) {
        expect(memory).toMatchObject({
          eventStart: date,
          eventEnd: endDate,
          temporalPrecision: precision,
        });
      }
    }
  );

  it('幂等：同会话同内容只建一个任务；内容变了才建新任务；跑完写入 source=distill 且过闭集校验', async () => {
    const fp = distillFingerprint(payload.sessionId, transcript);
    const job = ensureDistillJob(db, payload, fp);
    expect(job).not.toBeNull();
    // 还没跑完：返回同一任务而不是再建一条
    expect(ensureDistillJob(db, payload, fp)?.id).toBe(job!.id);
    expect(
      db.prepare("SELECT count(*) AS n FROM memory_jobs WHERE kind = 'distill'").get()
    ).toEqual({ n: 1 });
    const done = await runDistillJob(db, job!, {
      transcript,
      complete: async () =>
        json([
          mem(),
          mem({ content: 'Deploy on Fridays is banned; incidents.', unitType: 'vibe' }),
        ]),
    });
    expect(done).toMatchObject({ status: 'done', total: 2, done: 2, failed: 0 });
    expect(rows()).toEqual([
      expect.objectContaining({
        source: 'distill',
        unit_type: 'decision',
        unit_type_source: 'explicit',
      }),
      expect.objectContaining({
        source: 'distill',
        unit_type: 'fact',
        unit_type_source: 'fallback',
      }),
    ]);
    // 跑完后同指纹仍不建任务；即使强行再跑一次，也被 content_hash 去重挡住
    expect(ensureDistillJob(db, payload, fp)).toBeNull();
    const again = await runDistillJob(db, job!, {
      transcript,
      complete: async () => json([mem()]),
    });
    expect(again.status).toBe('done');
    expect(rows()).toHaveLength(2);
    // 会话继续了：新指纹 → 新任务
    const fp2 = distillFingerprint(payload.sessionId, `${transcript}\n\nUser: more`);
    expect(ensureDistillJob(db, payload, fp2)).not.toBeNull();
  });

  it('LLM 抛错 / 输出不可解析：暂时性失败，保留 pending 记 error 不写入；下次触发重跑成功写入', async () => {
    const fp = distillFingerprint('s1', transcript);
    const job = ensureDistillJob(db, payload, fp)!;
    const failed = await runDistillJob(db, job, {
      transcript,
      complete: async () => {
        throw new Error('provider down');
      },
    });
    expect(failed).toMatchObject({ status: 'pending', attempts: 1, done: 0 });
    expect(failed.error).toMatch(/provider down/);
    expect(rows()).toHaveLength(0);
    // 垃圾输出同样算暂时性
    const garbage = await runDistillJob(db, failed, { transcript, complete: async () => 'nope' });
    expect(garbage).toMatchObject({ status: 'pending', attempts: 2, total: 0 });
    expect(garbage.error).toMatch(/not parseable/);
    // 下一次 parent-ended：同指纹拿回同一任务，重跑成功
    const retry = ensureDistillJob(db, payload, fp);
    expect(retry?.id).toBe(job.id);
    const ok = await runDistillJob(db, retry!, { transcript, complete: async () => json([mem()]) });
    expect(ok).toMatchObject({ status: 'done', attempts: 3, total: 1, done: 1, error: null });
    expect(rows()).toHaveLength(1);
    expect(ensureDistillJob(db, payload, fp)).toBeNull();
  });

  it('多块提取硬截断时整轮 pending，成功块也不落库', async () => {
    const longTranscript = buildTranscript([
      { role: 'user', text: 'x'.repeat(DISTILL_MAX_CHUNK_CHARS * 2) },
    ]);
    const fp = distillFingerprint('multi-truncated', longTranscript);
    const job = ensureDistillJob(db, { ...payload, sessionId: 'multi-truncated' }, fp)!;
    const truncated = '{"memories":[{"content":"cut';
    const users: string[] = [];
    const failed = await runDistillJob(db, job, {
      transcript: longTranscript,
      complete: async (_system, user) => {
        users.push(user);
        if (/CHUNK 1\//.test(user)) return json([mem({ title: 'written-before-failure' })]);
        if (/CHUNK 2\//.test(user)) return truncated;
        throw new Error(`unexpected round: ${user.slice(0, 40)}`);
      },
    });
    expect(failed).toMatchObject({
      status: 'pending',
      attempts: 1,
      done: 0,
      total: 0,
    });
    expect(failed.error).toMatch(/incomplete JSON/);
    expect(rows()).toHaveLength(0);
    expect(users).toHaveLength(3);
    expect(users.every((user) => !user.includes('CHUNK 3/'))).toBe(true);
  });

  it('截断输出同轮只升预算一次；后续 attempt 首发硬上限且不重复升预算', async () => {
    const fp = distillFingerprint('s1', transcript);
    const job = ensureDistillJob(db, payload, fp)!;
    const truncated = '{"memories":[{"content":"cut';
    const firstBudgets: number[] = [];
    const failed = await runDistillJob(db, job, {
      transcript,
      complete: async (_system, _user, options) => {
        firstBudgets.push(options?.maxTokens ?? 0);
        return truncated;
      },
    });
    expect(firstBudgets).toEqual([DISTILL_SINGLE_EXTRACT_MAX_TOKENS, DISTILL_MAX_OUTPUT_TOKENS]);
    expect(failed).toMatchObject({ status: 'pending', attempts: 1, done: 0 });
    expect(failed.error).toMatch(/incomplete JSON/);

    const retryBudgets: number[] = [];
    const failedAgain = await runDistillJob(db, failed, {
      transcript,
      complete: async (_system, _user, options) => {
        retryBudgets.push(options?.maxTokens ?? 0);
        return truncated;
      },
    });
    expect(retryBudgets).toEqual([DISTILL_MAX_OUTPUT_TOKENS]);
    expect(failedAgain).toMatchObject({ status: 'pending', attempts: 2, done: 0 });
    expect(rows()).toHaveLength(0);
  });

  it('暂时性失败超过 DISTILL_MAX_ATTEMPTS 次标 done 记 error，不再重试', async () => {
    const fp = distillFingerprint('s1', transcript);
    let job = ensureDistillJob(db, payload, fp)!;
    const down = async () => {
      throw new Error('down');
    };
    for (let i = 0; i < DISTILL_MAX_ATTEMPTS; i++)
      job = await runDistillJob(db, job, { transcript, complete: down });
    expect(job).toMatchObject({ status: 'done', attempts: DISTILL_MAX_ATTEMPTS });
    expect(job.error).toMatch(/down/);
    expect(ensureDistillJob(db, payload, fp)).toBeNull();
  });

  it('模型正常返回但没有值得记的内容：确定性无产出，直接 done、error 为 null', async () => {
    const job = ensureDistillJob(db, payload, distillFingerprint('s1', transcript))!;
    const empty = await runDistillJob(db, job, {
      transcript,
      complete: async () => JSON.stringify({ memories: [], summary: 'small talk' }),
    });
    expect(empty).toMatchObject({ status: 'done', total: 0, done: 0, error: null });
    expect(rows()).toHaveLength(0);
  });

  it('importance<0.5 的条目丢弃计入 failed；候选网命中（近重复）放弃写入并记录', async () => {
    const e: Embedder = { model: 'const', dim: 2, embed: async () => Float32Array.from([1, 0]) };
    const long =
      'We standardised on PostgreSQL 16 for all new services because of team familiarity.'.repeat(
        2
      );
    expect(Array.from(long).length).toBeGreaterThanOrEqual(DEDUP_MIN_CHARS);
    await createMemory(db, { content: long, spaceId: 'global' }, { embedder: e });
    const job = ensureDistillJob(db, payload, distillFingerprint('s1', transcript))!;
    const done = await runDistillJob(db, job, {
      transcript,
      embedder: e,
      complete: async () =>
        json([
          mem({ content: `${long} (restated)` }),
          mem({ importance: 0.3, content: 'trivial chatter' }),
          mem({ content: 'Short unrelated durable fact about deploys.' }),
        ]),
    });
    expect(done).toMatchObject({ status: 'done', total: 3, done: 1, failed: 2, error: null });
    // 丢弃原因结构化，设置页可直接展示
    expect(done.notes.map((n) => n.kind).sort()).toEqual(['candidates_found', 'low_importance']);
    expect(done.notes.find((n) => n.kind === 'candidates_found')?.detail).toMatch(
      /1 near-duplicate/
    );
    expect(listDistillJobs(db)[0]?.notes).toEqual(done.notes);
    expect(rows().map((r) => r.content)).toEqual([
      long,
      'Short unrelated durable fact about deploys.',
    ]);
  });

  it('重启续跑：pending/running 任务持久化，重开库后可列出并完成', async () => {
    const job = ensureDistillJob(db, payload, distillFingerprint('s1', transcript))!;
    db.prepare("UPDATE memory_jobs SET status = 'running' WHERE id = ?").run(job.id);
    db.close();
    db = openMemoryDb(path.join(dir, 'memory.db'));
    const resumable = listResumableDistillJobs(db);
    expect(resumable).toHaveLength(1);
    expect(resumable[0]).toMatchObject({ id: job.id, payload, fingerprint: job.fingerprint });
    const done = await runDistillJob(db, resumable[0], {
      transcript,
      complete: async () => json([mem()]),
    });
    expect(done.status).toBe('done');
    expect(listResumableDistillJobs(db)).toEqual([]);
    expect(rows()).toHaveLength(1);
  });

  it('续跑时会话内容已变（指纹不符）：标 cancelled，不写入', async () => {
    const job = ensureDistillJob(db, payload, distillFingerprint('s1', transcript))!;
    const out = await runDistillJob(db, job, {
      transcript: `${transcript}\n\nUser: changed`,
      complete: async () => json([mem()]),
    });
    expect(out.status).toBe('cancelled');
    expect(rows()).toHaveLength(0);
  });
});
