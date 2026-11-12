import { describe, expect, it } from 'vitest';
import {
  cleanToolBatchLabel,
  parseToolBatchDigest,
  toolBatchDigest,
  toolBatchLabelPrompt,
} from './toolBatchLabel';

const assistant = (content: unknown[]) => ({ role: 'assistant', content });
const call = (id: string, name: string, args: unknown = {}) => ({
  type: 'toolCall',
  id,
  name,
  arguments: args,
});
const result = (id: string, text: string, isError = false) => ({
  role: 'toolResult',
  toolCallId: id,
  content: [{ type: 'text', text }],
  isError,
});

describe('toolBatchDigest', () => {
  it('以首个工具调用 id 为键，带上意图、截断的参数与结果', () => {
    const digest = toolBatchDigest(
      assistant([
        { type: 'text', text: 'Let me look at the auth module.' },
        call('c1', 'grep', { pattern: 'login', path: 'src/auth' }),
        call('c2', 'read', { path: 'x'.repeat(1000) }),
      ]),
      [result('c1', 'src/auth/login.ts:12: login()'), result('c2', 'boom', true)]
    );
    expect(digest?.callId).toBe('c1');
    expect(digest?.intent).toBe('Let me look at the auth module.');
    expect(digest?.tools[0]).toEqual({
      name: 'grep',
      input: '{"pattern":"login","path":"src/auth"}',
      output: 'src/auth/login.ts:12: login()',
    });
    expect(digest?.tools[1].input.length).toBeLessThanOrEqual(300);
    expect(digest?.tools[1].output).toBe('error: boom');
  });

  it('没有工具调用或只有记账类工具时不生成', () => {
    expect(toolBatchDigest(assistant([{ type: 'text', text: 'hi' }]), [])).toBeUndefined();
    expect(
      toolBatchDigest(assistant([call('t1', 'todo'), call('m1', 'explore_mark')]), [])
    ).toBeUndefined();
    expect(toolBatchDigest({ role: 'user', content: [] }, [])).toBeUndefined();
  });
});

describe('toolBatchLabelPrompt', () => {
  it('意图前缀可选，工具逐条列出', () => {
    const prompt = toolBatchLabelPrompt({
      callId: 'c1',
      tools: [{ name: 'bash', input: '{"command":"pnpm test"}', output: 'ok' }],
    });
    expect(prompt).not.toContain('intent');
    expect(prompt).toContain('Tool: bash\nInput: {"command":"pnpm test"}\nOutput: ok');
    expect(prompt.endsWith('Label:')).toBe(true);
  });
});

describe('parseToolBatchDigest', () => {
  it('合法 digest 通过，脏输入与超长字段拒绝', () => {
    const digest = toolBatchDigest(assistant([call('c1', 'grep', { pattern: 'x' })]), [
      result('c1', 'hit'),
    ]);
    expect(parseToolBatchDigest(digest)).toEqual(digest);
    expect(parseToolBatchDigest({ callId: 'c1', tools: [] })).toBeNull();
    expect(
      parseToolBatchDigest({ callId: '', tools: [{ name: 'a', input: '', output: '' }] })
    ).toBeNull();
    expect(
      parseToolBatchDigest({
        callId: 'c1',
        tools: [{ name: 'a', input: 'x'.repeat(301), output: '' }],
      })
    ).toBeNull();
    expect(parseToolBatchDigest('nope')).toBeNull();
  });
});

describe('cleanToolBatchLabel', () => {
  it('取首行、去引号与前缀', () => {
    expect(cleanToolBatchLabel('"Searched in auth/"\nextra')).toBe('Searched in auth/');
    expect(cleanToolBatchLabel('Label: Ran failing tests')).toBe('Ran failing tests');
    expect(cleanToolBatchLabel('- Read config.json')).toBe('Read config.json');
  });

  it('空、错误或拒答样式的输出丢弃，过长截断', () => {
    expect(cleanToolBatchLabel('   ')).toBeUndefined();
    expect(cleanToolBatchLabel('Error: rate limited')).toBeUndefined();
    expect(cleanToolBatchLabel('I cannot help with that')).toBeUndefined();
    expect(cleanToolBatchLabel('x'.repeat(200))?.length).toBeLessThanOrEqual(60);
  });
});
