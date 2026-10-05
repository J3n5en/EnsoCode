import { describe, expect, it } from 'vitest';
import { buildRequestBodySegment } from './requestBodySegment';

const t = (key: string, params?: Record<string, string | number>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, n: string) => String(params?.[n] ?? ''));
const usage = {
  bytes: 1024 * 1024,
  limitBytes: 32 * 1024 * 1024,
  stage: 'wire' as const,
  blocked: false,
  at: 1,
};
describe('底部请求体明细显示', () => {
  it('没有实测值不编造 0 字节', () => expect(buildRequestBodySegment(t)).toBeUndefined());
  it('区分 MiB 与 MB，用最近一次实测大小和该次上限，不与 token 水位混算', () => {
    expect(buildRequestBodySegment(t, usage)).toMatchObject({
      compact: '1.00 MiB',
      critical: false,
    });
    expect(buildRequestBodySegment(t, usage)?.full).toContain('32.00 MiB');
    expect(buildRequestBodySegment(t, usage)?.full).toContain('Before send');
  });
  it('序列化阶段不当成网络已成功，超限保留实际大于上限的字节并标红', () => {
    expect(buildRequestBodySegment(t, { ...usage, stage: 'payload' })?.full).toContain(
      'Serialized payload'
    );
    const value = buildRequestBodySegment(t, { ...usage, bytes: 40 * 1024 * 1024, blocked: true });
    expect(value).toMatchObject({ compact: '40.00 MiB', critical: true });
    expect(value?.full).toContain('125%');
    expect(value?.full).toContain('Blocked before send');
  });
  it('未超限但接近 90% 时预警，不改变 bytes / limit 口径', () => {
    expect(buildRequestBodySegment(t, { ...usage, bytes: 30 * 1024 * 1024 })?.critical).toBe(true);
  });
});
