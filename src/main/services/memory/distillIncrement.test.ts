import { describe, expect, it } from 'vitest';
import { sliceTranscript, type TranscriptMessage } from './distill';

const msgs: TranscriptMessage[] = [
  { role: 'user', text: 'a', entryId: 'e1' },
  { role: 'assistant', text: 'b', entryId: 'e2' },
  { role: 'assistant', text: 'b2', entryId: 'e2' },
  { role: 'user', text: 'c', entryId: 'e3' },
  { role: 'assistant', text: 'd', entryId: 'e4' },
];
const texts = (r: { messages: TranscriptMessage[] }) => r.messages.map((m) => m.text);

describe('sliceTranscript（增量蒸馏水位）', () => {
  it('无起点 = 全量，水位是最后一条 entry', () => {
    const r = sliceTranscript(msgs);
    expect(texts(r)).toEqual(['a', 'b', 'b2', 'c', 'd']);
    expect(r.watermark).toBe('e4');
  });

  it('从水位之后取；同一 entry 产出的多条消息整体跳过', () => {
    const r = sliceTranscript(msgs, 'e2');
    expect(texts(r)).toEqual(['c', 'd']);
    expect(r.watermark).toBe('e4');
  });

  it('没有新内容：空切片，水位不动', () => {
    expect(sliceTranscript(msgs, 'e4')).toEqual({ messages: [], watermark: 'e4' });
    expect(sliceTranscript([], 'e9')).toEqual({ messages: [], watermark: 'e9' });
    expect(sliceTranscript([])).toEqual({ messages: [], watermark: undefined });
  });

  it('有终点（续跑旧任务）：只取 (from, to]，不吞后来新增的内容', () => {
    const r = sliceTranscript(msgs, 'e1', 'e2');
    expect(texts(r)).toEqual(['b', 'b2']);
    expect(r.watermark).toBe('e2');
  });

  it('起点不在当前分支（切过分支）：退回全量，不丢内容', () => {
    expect(texts(sliceTranscript(msgs, 'gone'))).toHaveLength(5);
  });

  it('消息没有 entryId（旧读取器）：全量，水位保持起点', () => {
    const plain: TranscriptMessage[] = [{ role: 'user', text: 'x' }];
    expect(sliceTranscript(plain, 'e1')).toEqual({ messages: plain, watermark: 'e1' });
  });
});
