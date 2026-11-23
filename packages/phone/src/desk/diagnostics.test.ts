import { describe, expect, it } from 'vitest';
import { formatDiagnostics } from './diagnostics';

describe('formatDiagnostics', () => {
  it('带上构建、链路与时间线，时间线按页面启动时刻换成绝对时间', () => {
    const text = formatDiagnostics({
      now: Date.UTC(2026, 10, 23, 5, 0, 10),
      bornAt: Date.UTC(2026, 10, 23, 5, 0, 0),
      build: '0.3.12-abc',
      userAgent: 'iPhone',
      visibility: 'visible',
      link: { state: 'online', transport: 'direct', rttMs: 42 },
      trace: ['0 state connecting', '1500 gap e65d applied=3 got=9', 'broken'],
    });
    expect(text).toContain('build 0.3.12-abc');
    expect(text).toContain('iPhone');
    expect(text).toContain('"transport":"direct"');
    expect(text).toContain('页面已运行 10s');
    expect(text).toMatch(/05:00:00\.000 \+0ms state connecting/);
    expect(text).toMatch(/05:00:01\.500 \+1500ms gap e65d/);
    expect(text).toContain('broken');
  });
});
