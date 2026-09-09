import { describe, expect, it } from 'vitest';
import { sanitizeTruncationDetails, withReadTruncationMeta } from './readTruncation';

describe('sanitizeTruncationDetails', () => {
  it('去掉 truncation.content，补 shownLines/totalLines/nextOffset', () => {
    const details = {
      truncation: {
        truncated: true,
        content: 'x'.repeat(50_000),
        outputLines: 1002,
        totalLines: 15294,
      },
    };
    expect(sanitizeTruncationDetails(details, 1)).toEqual({
      truncation: {
        truncated: true,
        shownLines: 1002,
        totalLines: 15294,
        bytesLimit: 51200,
        nextOffset: 1003,
      },
    });
  });

  it('从 offset 续读时 nextOffset 接在本页之后，totalLines 还原为文件总行数', () => {
    const details = {
      truncation: { truncated: true, content: 'body', outputLines: 10, totalLines: 40 },
    };
    expect(sanitizeTruncationDetails(details, 11)).toEqual({
      truncation: {
        truncated: true,
        shownLines: 10,
        totalLines: 50,
        bytesLimit: 51200,
        nextOffset: 21,
      },
    });
  });

  it('pi 的 totalLines 是剩余行，要加回 offset 才是 wc -l 总行数', () => {
    expect(
      sanitizeTruncationDetails(
        {
          truncation: {
            truncated: true,
            outputLines: 1002,
            totalLines: 14291,
          },
        },
        1003
      )
    ).toEqual({
      truncation: {
        truncated: true,
        shownLines: 1002,
        totalLines: 15293,
        bytesLimit: 51200,
        nextOffset: 2005,
      },
    });
  });

  it('无 truncation 或无 content 时不改形状以外的字段', () => {
    expect(sanitizeTruncationDetails({ path: 'a.ts' })).toEqual({ path: 'a.ts' });
  });
});

describe('withReadTruncationMeta', () => {
  it('execute 后 details 不再带正文', async () => {
    const inner = {
      name: 'read',
      async execute(_id: string, _params: unknown) {
        return {
          content: [{ type: 'text', text: 'shown' }],
          details: {
            truncation: {
              truncated: true,
              content: 'FULL',
              outputLines: 2,
              totalLines: 9,
            },
          },
        };
      },
    };
    const wrapped = withReadTruncationMeta(inner);
    const result = await wrapped.execute('id', { path: 'a.ts' });
    expect(result.details.truncation).toEqual({
      truncated: true,
      shownLines: 2,
      totalLines: 9,
      bytesLimit: 51200,
      nextOffset: 3,
    });
    expect(JSON.stringify(result.details)).not.toContain('FULL');
  });

  it('页脚 of N 与 details.totalLines 都用 wc -l，不是剩余行或 split(\\n).length', async () => {
    const inner = {
      name: 'read',
      async execute(_id: string, _params: unknown) {
        return {
          content: [
            {
              type: 'text',
              text: 'shown\n\n[Showing lines 1003-2004 of 15294. Use offset=2005 to continue.]',
            },
          ],
          details: {
            truncation: {
              truncated: true,
              content: 'FULL',
              outputLines: 1002,
              totalLines: 14291,
            },
          },
        };
      },
    };
    const wrapped = withReadTruncationMeta(inner);
    const result = await wrapped.execute('id', { path: 'a.ts', offset: 1003 });
    expect(result.details.truncation).toMatchObject({ totalLines: 15293 });
    expect(result.content[0].text).toContain('of 15293');
    expect(result.content[0].text).not.toContain('of 15294');
  });
});
