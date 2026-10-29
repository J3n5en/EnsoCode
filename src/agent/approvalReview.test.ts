import { APPROVAL_REVIEW_REASONS } from '@shared/approvalReviewRecord';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_CLASSIFIER_THRESHOLD,
  buildApprovalClassifierRequest,
  computeApprovalActionHash,
  decideFromApprovalClassifier,
  decideManagedApproval,
  extractJsonObjectText,
  normalizeReviewDecision,
  recentReviewMessages,
} from './approvalReview';

const HASH = 'deadbeef';

describe('extractJsonObjectText', () => {
  it('无花括号/空/非 JSON 文本返回 null', () => {
    expect(extractJsonObjectText('')).toBeNull();
    expect(extractJsonObjectText('no json here')).toBeNull();
    expect(extractJsonObjectText('   ')).toBeNull();
  });

  it('提取裸 JSON 对象文本', () => {
    const raw = '{"decision":"allow"}';
    expect(extractJsonObjectText(raw)).toBe(raw);
  });

  it('提取被前后缀文字包裹的 JSON 对象', () => {
    const raw = 'Here is my answer:\n{"decision":"allow","riskLevel":"low"}\nThanks.';
    expect(extractJsonObjectText(raw)).toBe('{"decision":"allow","riskLevel":"low"}');
  });

  it('提取 ```json 围栏内的 JSON', () => {
    const raw = '```json\n{"decision":"block","riskLevel":"critical"}\n```';
    expect(extractJsonObjectText(raw)).toBe('{"decision":"block","riskLevel":"critical"}');
  });
});

describe('normalizeReviewDecision', () => {
  it('非 JSON / 空 / 无花括号 → ask_user，rationale 含 JSON 字样', () => {
    for (const raw of ['', 'not json at all', '   ']) {
      const result = normalizeReviewDecision(raw, HASH);
      expect(result.decision).toBe('ask_user');
      expect(result.actionHash).toBe(HASH);
      expect(result.rationale).toMatch(/json/i);
    }
  });

  it('坏 JSON（截断/非法语法）→ ask_user', () => {
    const result = normalizeReviewDecision('{"decision":"allow", "riskLevel"', HASH);
    expect(result.decision).toBe('ask_user');
    expect(result.actionHash).toBe(HASH);
  });

  it('actionHash 不匹配 → ask_user，rationale 含 hash 字样', () => {
    const raw = JSON.stringify({
      decision: 'auto_allow',
      risk_level: 'low',
      action_hash: 'other-hash',
    });
    const result = normalizeReviewDecision(raw, HASH);
    expect(result.decision).toBe('ask_user');
    expect(result.actionHash).toBe(HASH);
    expect(result.rationale).toMatch(/hash/i);
  });

  it('缺 actionHash → ask_user，rationale 含 hash 字样', () => {
    const raw = JSON.stringify({ decision: 'auto_allow', riskLevel: 'low' });
    const result = normalizeReviewDecision(raw, HASH);
    expect(result.decision).toBe('ask_user');
    expect(result.actionHash).toBe(HASH);
    expect(result.rationale).toMatch(/hash/i);
  });

  it('无合法 riskLevel → ask_user', () => {
    const raw = JSON.stringify({ decision: 'auto_allow', actionHash: HASH, riskLevel: 'unknown' });
    const result = normalizeReviewDecision(raw, HASH);
    expect(result.decision).toBe('ask_user');

    const missing = JSON.stringify({ decision: 'auto_allow', actionHash: HASH });
    expect(normalizeReviewDecision(missing, HASH).decision).toBe('ask_user');
  });

  it('risk=critical 无论 decision 是什么 → block', () => {
    for (const decision of ['allow', 'auto_allow', 'block']) {
      const raw = JSON.stringify({ decision, riskLevel: 'critical', actionHash: HASH });
      const result = normalizeReviewDecision(raw, HASH);
      expect(result.decision).toBe('block');
      expect(result.riskLevel).toBe('critical');
      expect(result.actionHash).toBe(HASH);
    }
  });

  it('risk=high 即使 decision=auto_allow → ask_user', () => {
    const raw = JSON.stringify({ decision: 'auto_allow', riskLevel: 'high', actionHash: HASH });
    const result = normalizeReviewDecision(raw, HASH);
    expect(result.decision).toBe('ask_user');
    expect(result.riskLevel).toBe('high');
  });

  it('risk=low|medium + decision auto_allow|allow → auto_allow', () => {
    for (const riskLevel of ['low', 'medium']) {
      for (const decision of ['auto_allow', 'allow']) {
        const raw = JSON.stringify({ decision, riskLevel, actionHash: HASH });
        const result = normalizeReviewDecision(raw, HASH);
        expect(result.decision).toBe('auto_allow');
        expect(result.riskLevel).toBe(riskLevel);
      }
    }
  });

  it('risk=low|medium + decision block|deny → ask_user（非 critical 不直接拦）', () => {
    for (const riskLevel of ['low', 'medium']) {
      for (const decision of ['block', 'deny']) {
        const raw = JSON.stringify({ decision, riskLevel, actionHash: HASH });
        const result = normalizeReviewDecision(raw, HASH);
        expect(result.decision).toBe('ask_user');
        expect(result.riskLevel).toBe(riskLevel);
      }
    }
  });

  it('其它/未知 decision → ask_user', () => {
    const raw = JSON.stringify({ decision: 'maybe', riskLevel: 'low', actionHash: HASH });
    const result = normalizeReviewDecision(raw, HASH);
    expect(result.decision).toBe('ask_user');
  });

  it('支持 ```json 围栏包裹', () => {
    const raw =
      '```json\n' +
      JSON.stringify({ decision: 'auto_allow', riskLevel: 'low', actionHash: HASH }) +
      '\n```';
    const result = normalizeReviewDecision(raw, HASH);
    expect(result.decision).toBe('auto_allow');
  });

  it('支持 risk_level / action_hash / outcome / reason 别名字段', () => {
    const raw = JSON.stringify({
      outcome: 'auto_allow',
      risk_level: 'medium',
      action_hash: HASH,
      reason: '低风险只读操作',
    });
    const result = normalizeReviewDecision(raw, HASH);
    expect(result.decision).toBe('auto_allow');
    expect(result.riskLevel).toBe('medium');
    expect(result.rationale).toBe('低风险只读操作');
  });
});

describe('computeApprovalActionHash', () => {
  it('同对象键序不同，哈希相同', () => {
    const a = { tool: 'bash', kind: 'command', summary: 'ls -la' };
    const b = { summary: 'ls -la', kind: 'command', tool: 'bash' };
    expect(computeApprovalActionHash(a)).toBe(computeApprovalActionHash(b));
  });

  it('改动任一字段，哈希变化', () => {
    const base = { tool: 'bash', kind: 'command', summary: 'ls -la' };
    const changed = { tool: 'bash', kind: 'command', summary: 'rm -rf /' };
    expect(computeApprovalActionHash(base)).not.toBe(computeApprovalActionHash(changed));
  });

  it('返回非空字符串', () => {
    const hash = computeApprovalActionHash({ tool: 'bash', kind: 'command', summary: 'ls' });
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });
});

describe('recentReviewMessages', () => {
  it('跳过 system 消息后取最近 N 条，只保留文本', () => {
    const messages = [
      ...Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: [{ type: 'text' as const, text: `m${i}` }],
      })),
      { role: 'system', content: [] },
      {
        role: 'assistant',
        content: [
          { type: 'text' as const, text: 'a' },
          { type: 'toolCall' as const, id: '1', name: 'bash' },
          { type: 'text' as const, text: 'b' },
        ],
      },
    ];
    const recent = recentReviewMessages(messages);
    expect(recent).toHaveLength(8);
    expect(recent.some((message) => message.role === 'system')).toBe(false);
    expect(recent[0]).toEqual({ role: 'assistant', content: 'm1' });
    expect(recent.at(-1)).toEqual({ role: 'assistant', content: 'a\n\nb' });
  });
});

describe('decideFromApprovalClassifier', () => {
  const choice = (probabilities: Record<string, unknown>) => ({
    type: 'choice',
    choice: 'allow',
    probabilities,
    confidence: 1,
  });

  it('allow / block 概率达到阈值才放行或拦截', () => {
    expect(
      decideFromApprovalClassifier(choice({ allow: 0.95, ask: 0.04, block: 0.01 }))
    ).toMatchObject({ decision: 'auto_allow' });
    expect(
      decideFromApprovalClassifier(choice({ allow: APPROVAL_CLASSIFIER_THRESHOLD, block: 0 }))
    ).toMatchObject({ decision: 'auto_allow' });
    expect(
      decideFromApprovalClassifier(choice({ allow: 0.01, ask: 0.02, block: 0.97 }))
    ).toMatchObject({ decision: 'block' });
  });

  it('未达阈值、ask 占优一律交人工', () => {
    for (const probabilities of [
      { allow: 0.89, ask: 0.1, block: 0.01 },
      { allow: 0.05, ask: 0.9, block: 0.05 },
      { allow: 0.5, ask: 0, block: 0.5 },
    ]) {
      expect(decideFromApprovalClassifier(choice(probabilities))).toMatchObject({
        decision: 'ask_user',
      });
    }
  });

  it('缺概率、非数值、非 choice 答案交人工', () => {
    for (const answer of [
      undefined,
      null,
      { type: 'boolean', value: true },
      { type: 'choice', choice: 'allow' },
      choice({ allow: '0.99' }),
      choice({ allow: Number.NaN }),
      choice({ allow: 1.5 }),
      choice({ block: Number.POSITIVE_INFINITY }),
    ]) {
      expect(decideFromApprovalClassifier(answer)).toMatchObject({ decision: 'ask_user' });
    }
  });

  it('理由带上三档概率，便于排查', () => {
    expect(
      decideFromApprovalClassifier(choice({ allow: 0.95, ask: 0.04, block: 0.01 })).rationale
    ).toContain('allow 0.95');
  });
});

describe('buildApprovalClassifierRequest', () => {
  it('只问三选一，截断过长的摘要与上下文', () => {
    const request = buildApprovalClassifierRequest({
      tool: 'bash',
      kind: 'command',
      summary: 'x'.repeat(5000),
      recentMessages: [{ role: 'user', content: 'y'.repeat(5000) }],
    });
    const question = request.questions.decision;
    expect(question.type).toBe('choice');
    expect(Object.keys(question.criteria).sort()).toEqual(['allow', 'ask', 'block']);
    expect(request.state.tool).toBe('bash');
    expect(String(request.state.action).length).toBeLessThan(2100);
    expect(JSON.stringify(request.state.recentMessages).length).toBeLessThan(2200);
  });
});

describe('放行阈值可选档位', () => {
  const choice = (allow: number) => ({
    type: 'choice',
    choice: 'allow',
    probabilities: { allow, ask: 1 - allow, block: 0 },
    confidence: 1,
  });
  const managed = (allow: number) => ({ decision: choice(allow) });

  it('0.85 档：0.86 放行，0.84 非托管问人、托管拒绝', () => {
    expect(decideFromApprovalClassifier(choice(0.86), 0.85).decision).toBe('auto_allow');
    expect(decideFromApprovalClassifier(choice(0.84), 0.85).decision).toBe('ask_user');
    expect(decideManagedApproval(managed(0.86), 'jev', 0.85).decision).toBe('auto_allow');
    const denied = decideManagedApproval(managed(0.84), 'jev', 0.85);
    expect(denied.decision).toBe('deny');
    expect(denied.decision === 'deny' && denied.message).toContain('allow >= 0.85');
  });

  it('非法阈值按 0.9；拦截阈值固定 0.9 不随放行档位变化', () => {
    expect(decideFromApprovalClassifier(choice(0.86), 0.5).decision).toBe('ask_user');
    expect(decideManagedApproval(managed(0.86), 'jev', 0.5).decision).toBe('deny');
    expect(decideFromApprovalClassifier(choice(0.92), 0.95).decision).toBe('ask_user');
    const block = { ...choice(0), probabilities: { allow: 0.05, ask: 0.07, block: 0.88 } };
    expect(decideFromApprovalClassifier(block, 0.85).decision).toBe('ask_user');
  });
});

describe('decideManagedApproval（托管）', () => {
  const answers = (probabilities: Record<string, unknown>, reason?: string) => ({
    decision: { type: 'choice', choice: 'allow', probabilities, confidence: 1 },
    ...(reason
      ? { reason: { type: 'choice', choice: reason, probabilities: {}, confidence: 1 } }
      : {}),
  });

  it('allow ≥ 0.9 才放行，并带判定记录', () => {
    expect(
      decideManagedApproval(answers({ allow: 0.95, ask: 0.04, block: 0.01 }, 'read_only'), 'jev')
    ).toEqual({
      decision: 'auto_allow',
      record: {
        verdict: 'allow',
        model: 'jev',
        allow: 0.95,
        ask: 0.04,
        block: 0.01,
        reason: 'read_only',
      },
    });
  });

  it('allow 低于阈值（即使 choice 是 allow）、ask 或 block 占优：拒绝并把英文理由交回模型', () => {
    for (const probabilities of [
      { allow: 0.67, ask: 0.1, block: 0.23 },
      { allow: 0.89, ask: 0.11, block: 0 },
      { allow: 0.05, ask: 0.9, block: 0.05 },
      { allow: 0, ask: 0, block: 1 },
    ]) {
      const result = decideManagedApproval(answers(probabilities, 'unclear_target'), 'jev');
      expect(result.decision).toBe('deny');
      if (result.decision !== 'deny') continue;
      expect(result.record).toMatchObject({
        verdict: 'deny',
        model: 'jev',
        reason: 'unclear_target',
      });
      expect(result.message).toContain('was not run');
      expect(result.message).toContain('jev');
      expect(result.message).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it('理由缺失或不在固定分类里时不影响判定，记录里不带 reason', () => {
    const result = decideManagedApproval(
      {
        ...answers({ allow: 0.2, ask: 0.3, block: 0.5 }),
        reason: { type: 'choice', choice: 'pwned' },
      },
      'jev'
    );
    expect(result.decision).toBe('deny');
    if (result.decision === 'deny') expect(result.record).not.toHaveProperty('reason');
  });

  it('缺判定、缺概率或数值非法：判定无效，退回人工', () => {
    for (const bad of [
      undefined,
      {},
      { decision: { type: 'choice', choice: 'allow' } },
      answers({ allow: '0.99' }),
      answers({ allow: 1.5 }),
    ]) {
      expect(decideManagedApproval(bad, 'jev')).toMatchObject({
        decision: 'ask_user',
        fallback: 'invalid',
      });
    }
  });
});

describe('buildApprovalClassifierRequest 托管模式', () => {
  it('托管时多问一个固定分类的 reason，不托管时只问三选一', () => {
    const params = { tool: 'bash', kind: 'command', summary: 'ls', recentMessages: [] };
    expect(Object.keys(buildApprovalClassifierRequest(params).questions)).toEqual(['decision']);
    const managed = buildApprovalClassifierRequest(params, { managed: true });
    expect(Object.keys(managed.questions)).toEqual(['decision', 'reason']);
    expect(Object.keys(managed.questions.reason?.criteria ?? {}).sort()).toEqual(
      [...APPROVAL_REVIEW_REASONS].sort()
    );
  });
});
