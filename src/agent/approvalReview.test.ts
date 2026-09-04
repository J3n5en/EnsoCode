import { describe, expect, it } from 'vitest';
import {
  computeApprovalActionHash,
  extractJsonObjectText,
  normalizeReviewDecision,
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
