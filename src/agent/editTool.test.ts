import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../shared/capabilities/types';
import { matchesJsonSchema } from '../tooling/productCapabilityCoverage.fixture';
import { createNormalizedEditTool, normalizeEditArguments } from './editTool';
import { InMemorySnapshotStore } from './hashline/snapshots';
import { wrapHashlineEditDefinition } from './hashline/tools';

const block = { oldText: 'a', newText: 'b' };

describe('normalizeEditArguments', () => {
  it('完整 JSON 字符串 edits 还原为对象数组', () => {
    expect(normalizeEditArguments({ path: 'f.ts', edits: JSON.stringify([block]) })).toEqual({
      path: 'f.ts',
      edits: [block],
    });
  });

  it('双重编码 JSON 字符串递归 unwrap', () => {
    const encoded = JSON.stringify(JSON.stringify([block]));
    expect(normalizeEditArguments({ path: 'f.ts', edits: encoded })).toEqual({
      path: 'f.ts',
      edits: [block],
    });
  });

  it('数组元素是对象 JSON 字符串时逐项 parse', () => {
    expect(normalizeEditArguments({ path: 'f.ts', edits: [JSON.stringify(block)] })).toEqual({
      path: 'f.ts',
      edits: [block],
    });
  });

  it('单个 {oldText,newText} 包成一元素数组', () => {
    expect(normalizeEditArguments({ path: 'f.ts', edits: block })).toEqual({
      path: 'f.ts',
      edits: [block],
    });
  });

  it('截断 JSON 字符串拒绝并指导重新发送完整参数', () => {
    const truncated = '[{"oldText": "foo"';
    expect(() => normalizeEditArguments({ path: 'f.ts', edits: truncated })).toThrow(
      /No files were changed.*oldText.*newText.*Do not.*JSON string/s
    );
  });

  it('折叠成 edits: [json 数组字符串] 时拉平为对象数组', () => {
    expect(normalizeEditArguments({ path: 'f.ts', edits: [JSON.stringify([block])] })).toEqual({
      path: 'f.ts',
      edits: [block],
    });
  });

  it('数组装对象 {"0": {oldText,newText}} 转成数组', () => {
    expect(normalizeEditArguments({ path: 'f.ts', edits: { 0: block } })).toEqual({
      path: 'f.ts',
      edits: [block],
    });
  });

  it('已合法的 edits 数组不改写', () => {
    const input = { path: 'f.ts', edits: [block] };
    expect(normalizeEditArguments(input)).toEqual(input);
  });

  it('非对象入参原样返回', () => {
    expect(normalizeEditArguments(null)).toBeNull();
    expect(normalizeEditArguments('x')).toBe('x');
  });
  it.each(Array.from({ length: 32 }, (_, code) => code))(
    '完整 JSON 字符串内的控制字符 %i 保持原文还原',
    (code) => {
      const character = String.fromCharCode(code);
      const edits = `[{"oldText":"a${character}b","newText":"c${character}d"}]`;
      expect(normalizeEditArguments({ path: 'f.ts', edits })).toEqual({
        path: 'f.ts',
        edits: [{ oldText: `a${character}b`, newText: `c${character}d` }],
      });
    }
  );

  it('控制字符兼容不改写已有反斜线、引号、Unicode转义和结构空白', () => {
    const edit = { oldText: 'a\tb\\n"c', newText: '\r\n\\path\\"\u0000' };
    const encoded = JSON.stringify([edit]).replace('\\t', '\t');
    expect(normalizeEditArguments({ edits: ` \n${encoded}\r\n` })).toEqual({ edits: [edit] });
  });

  it.each([
    '[{"oldText":"a\tb","newText":"c',
    '[{"oldText":"a\tb","newText":"c"}',
    '[{"oldText":"a\tb","newText":"c"},]',
    '[{"oldText":"a\tb","newText":"\\q"}]',
    '[{"oldText":"a\\\nb","newText":"c"}]',
    '[{"oldText":"a","newText":"b"}] trailing',
  ])('不猜测修复截断、非法转义或多余内容：%j', (edits) => {
    expect(() => normalizeEditArguments({ edits, newText: 'do not splice' })).toThrow();
  });
});

describe.each([false, true])('edit 工具完整契约（Hashline=%s）', (hashline) => {
  function toolFor(cwd: string) {
    const stock = createNormalizedEditTool(cwd);
    return hashline
      ? wrapHashlineEditDefinition(stock, {
          store: new InMemorySnapshotStore(),
          readText: (path) => readFile(path, 'utf8'),
          writeText: (path, text) => writeFile(path, text),
        })
      : stock;
  }

  it('公开schema接受单次和批量形式，批量项必须有两个字符串字段', () => {
    const tool = toolFor('/tmp');
    const schema = tool.parameters as unknown as JsonSchema;
    expect(matchesJsonSchema(schema, { path: 'f.ts', ...block })).toBe(true);
    expect(matchesJsonSchema(schema, { path: 'f.ts', edits: [block] })).toBe(true);
    expect(matchesJsonSchema(schema, { path: 'f.ts', edits: [{ oldText: 'a' }] })).toBe(false);
    expect(matchesJsonSchema(schema, { path: 'f.ts', edits: [{ newText: 'b' }] })).toBe(false);
    expect(matchesJsonSchema(schema, { path: 'f.ts', edits: [{ oldText: 1, newText: 'b' }] })).toBe(
      false
    );
    expect(matchesJsonSchema(schema, { path: 'f.ts', edits: JSON.stringify([block]) })).toBe(false);
  });

  it('工具描述明确真实数组及单次替换格式', () => {
    const tool = toolFor('/tmp');
    expect(tool.description).toMatch(/Do not.*JSON string/s);
    expect(tool.description).toMatch(/single.*oldText.*newText/is);
    expect(tool.promptGuidelines?.join('\n')).toMatch(/Do not.*JSON string/s);
  });

  it('参数先归一再通过本工具schema，执行后文件内容正确', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'enso-edit-'));
    try {
      const path = join(cwd, 'f.ts');
      const tool = toolFor(cwd);
      const prepare = tool.prepareArguments as (args: unknown) => unknown;
      const execute = tool.execute as (id: string, args: unknown) => Promise<unknown>;
      for (const args of [
        { path, oldText: 'a\tb', newText: 'c\td' },
        { path, edits: [{ oldText: 'a\tb', newText: 'c\td' }] },
        { path, edits: '[{"oldText":"a\tb","newText":"c\td"}]' },
      ]) {
        await writeFile(path, 'a\tb\n');
        const prepared = prepare(args);
        expect(matchesJsonSchema(tool.parameters as unknown as JsonSchema, prepared)).toBe(true);
        await execute('test', prepared);
        expect(await readFile(path, 'utf8')).toBe('c\td\n');
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('截断edits和顶层newText混发时执行拒绝，文件保持原样', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'enso-edit-'));
    try {
      const path = join(cwd, 'f.ts');
      await writeFile(path, 'a\tb\n');
      const tool = toolFor(cwd);
      const args = { path, edits: '[{"oldText":"a\tb', newText: 'changed' };
      expect(() => tool.prepareArguments?.(args)).toThrow(/No files were changed/);
      const execute = tool.execute as (id: string, args: unknown) => Promise<unknown>;
      await expect(execute('test', args)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe('a\tb\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
