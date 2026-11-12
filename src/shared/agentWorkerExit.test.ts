import { describe, expect, it } from 'vitest';
import { describeAgentWorkerExit, parseAgentWorkerCrash } from './agentWorkerExit';

describe('parseAgentWorkerCrash', () => {
  it('接受完整记录，拒绝缺字段或坏类型', () => {
    const crash = { pid: 7, at: 1, origin: 'unhandledRejection', message: 'boom', stack: 's' };
    expect(parseAgentWorkerCrash(crash)).toEqual(crash);
    expect(parseAgentWorkerCrash({ ...crash, pid: '7' })).toBeNull();
    expect(parseAgentWorkerCrash({ ...crash, message: undefined })).toBeNull();
    expect(parseAgentWorkerCrash(null)).toBeNull();
    expect(parseAgentWorkerCrash('x')).toBeNull();
  });
});

describe('describeAgentWorkerExit', () => {
  it('有崩溃记录时给出来源、首行错误和内存', () => {
    expect(
      describeAgentWorkerExit(1, {
        pid: 7,
        at: 1,
        origin: 'uncaughtException',
        message: 'TypeError: x is not a function\n    at foo',
        rss: 1.5 * 1024 ** 3,
      })
    ).toBe('uncaughtException: TypeError: x is not a function (code=1, rss=1536MB)');
  });

  it('Windows 已知异常码转十六进制并注明含义', () => {
    expect(describeAgentWorkerExit(0xe0000008, null)).toBe('code=0xE0000008 out of memory');
    expect(describeAgentWorkerExit(-1073741819, null)).toBe('code=0xC0000005 access violation');
    expect(describeAgentWorkerExit(-36861, null)).toBe(
      'code=0xFFFF7003 native crash, crash handler not connected'
    );
  });

  it('普通退出码与缺失退出码', () => {
    expect(describeAgentWorkerExit(1, null)).toBe('code=1');
    expect(describeAgentWorkerExit(undefined, null)).toBe('code=unknown');
  });
});
