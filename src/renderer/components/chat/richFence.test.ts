import { describe, expect, it } from 'vitest';
import { classifyFence, parseAnsi, parseJsonLoose, splitConsole } from './richFence';

describe('classifyFence', () => {
  it('json / jsonc 标记且能解析时识别为 JSON 树，解析失败回落代码块', () => {
    expect(classifyFence('json', '{"a": 1}')).toBe('json');
    expect(classifyFence('JSONC', '{\n  // note\n  "a": [1, 2,],\n}')).toBe('json');
    expect(classifyFence('json', '{"a": 1')).toBeNull();
    expect(classifyFence('json', '42')).toBeNull();
  });

  it('无语言标记的对象/数组也识别，其它语言不猜', () => {
    expect(classifyFence(undefined, '[{"id": 1}]')).toBe('json');
    expect(classifyFence('ts', '{"a": 1}')).toBeNull();
    expect(classifyFence(undefined, 'plain text')).toBeNull();
  });

  it('终端：console 类标记、含 ANSI 转义、或 `$ 命令` 后跟输出', () => {
    expect(classifyFence('console', 'anything')).toBe('terminal');
    expect(classifyFence('shell-session', 'x')).toBe('terminal');
    expect(classifyFence('output', 'x')).toBe('terminal');
    expect(classifyFence('text', '\u001b[31mred\u001b[0m')).toBe('terminal');
    expect(classifyFence('bash', '$ npm test\n27 passed')).toBe('terminal');
    expect(classifyFence(undefined, '$ ls\nREADME.md')).toBe('terminal');
  });

  it('纯脚本（全是命令或没有提示符）不当终端', () => {
    expect(classifyFence('bash', 'npm install\nnpm test')).toBeNull();
    expect(classifyFence('bash', '$ npm install\n$ npm test')).toBeNull();
    expect(classifyFence('python', '$ x\ny')).toBeNull();
  });
});

describe('parseJsonLoose', () => {
  it('去掉注释与尾逗号，不误伤字符串里的 // 与逗号', () => {
    expect(
      parseJsonLoose('{\n  "url": "https://a.b/c", // 地址\n  /* block */ "list": [1,],\n}')
    ).toEqual({ ok: true, value: { url: 'https://a.b/c', list: [1] } });
    expect(parseJsonLoose('{"s": "a,]"}')).toEqual({ ok: true, value: { s: 'a,]' } });
    expect(parseJsonLoose('{"a": }')).toEqual({ ok: false });
  });
});

describe('parseAnsi', () => {
  it('按 SGR 切分前景色、粗体与重置', () => {
    expect(parseAnsi('a\u001b[1;31mb\u001b[0mc')).toEqual([
      { text: 'a' },
      { text: 'b', bold: true, fg: 'red' },
      { text: 'c' },
    ]);
  });

  it('支持亮色、256 色与真彩，22/39 只清对应属性', () => {
    expect(parseAnsi('\u001b[92mx\u001b[38;5;196my\u001b[38;2;1;2;3mz')).toEqual([
      { text: 'x', fg: 'bright-green' },
      { text: 'y', fg: '#ff0000' },
      { text: 'z', fg: 'rgb(1,2,3)' },
    ]);
    expect(parseAnsi('\u001b[1;32ma\u001b[22mb\u001b[39mc')).toEqual([
      { text: 'a', bold: true, fg: 'green' },
      { text: 'b', fg: 'green' },
      { text: 'c' },
    ]);
  });

  it('丢弃非 SGR 的 CSI 与 OSC 序列，不吐出乱码', () => {
    expect(parseAnsi('\u001b]0;title\u0007a\u001b[2Kb\u001b[?25lc')).toEqual([{ text: 'abc' }]);
  });
});

describe('splitConsole', () => {
  it('`$ ` 开头为命令，其余为输出，连续输出合并', () => {
    expect(splitConsole('$ npm test\nok 1\nok 2\n$ echo hi\nhi')).toEqual([
      { kind: 'command', text: 'npm test' },
      { kind: 'output', text: 'ok 1\nok 2' },
      { kind: 'command', text: 'echo hi' },
      { kind: 'output', text: 'hi' },
    ]);
  });
});
