import type { SecretaryToolDraft } from '@shared/types/secretary';
import { describe, expect, it } from 'vitest';
import {
  parseSecretaryToolDescriptors,
  parseSecretaryToolDraft,
  parseSecretaryToolFile,
  renderSecretaryToolFile,
  secretaryToolDescriptor,
  secretaryToolId,
  secretaryToolScriptFile,
  TOOL_CODE_MAX,
  TOOL_PARAMETERS_MAX,
} from './customTools';

const draft: SecretaryToolDraft = {
  name: 'upper-text',
  description: '把文本转成大写',
  runtime: 'node',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  readOnly: true,
  timeoutSec: 30,
  code: 'process.stdout.write("x")',
};

describe('parseSecretaryToolDraft', () => {
  it('收窄一份完整草案', () => {
    expect(parseSecretaryToolDraft({ ...draft })).toEqual({ ok: true, draft });
  });

  it('readOnly 缺省为 false，timeoutSec 缺省不下发', () => {
    const result = parseSecretaryToolDraft({
      ...draft,
      readOnly: undefined,
      timeoutSec: undefined,
    });
    expect(result.ok && result.draft.readOnly).toBe(false);
    expect(result.ok && 'timeoutSec' in result.draft).toBe(false);
  });

  it('拒绝穿越名、大写名与超长名', () => {
    for (const name of ['../escape', 'Upper', 'a--b', `${'a'.repeat(49)}`]) {
      expect(parseSecretaryToolDraft({ ...draft, name })).toEqual({
        ok: false,
        error: 'invalid tool name',
      });
    }
  });

  it('拒绝非 object 的参数结构、超限参数与超限代码', () => {
    expect(parseSecretaryToolDraft({ ...draft, parameters: { type: 'string' } })).toEqual({
      ok: false,
      error: 'invalid tool parameters',
    });
    expect(parseSecretaryToolDraft({ ...draft, parameters: [] })).toEqual({
      ok: false,
      error: 'invalid tool parameters',
    });
    const huge = {
      type: 'object',
      properties: { text: { type: 'string', description: 'x'.repeat(TOOL_PARAMETERS_MAX) } },
    };
    expect(parseSecretaryToolDraft({ ...draft, parameters: huge })).toEqual({
      ok: false,
      error: 'invalid tool parameters',
    });
    expect(parseSecretaryToolDraft({ ...draft, code: 'x'.repeat(TOOL_CODE_MAX + 1) })).toEqual({
      ok: false,
      error: 'invalid tool code',
    });
  });

  it('拒绝会让每轮请求都失败的结构坏参数', () => {
    const bad = [
      { type: 'object', properties: 'text' },
      { type: 'object', properties: { text: 'string' } },
      { type: 'object', properties: { text: { type: 'string' } }, required: 'text' },
      { type: 'object', properties: { text: { type: 'string' } }, required: ['missing'] },
      { type: 'object', properties: { text: { type: 'string' } }, required: [1] },
      { type: 'object', required: ['text'] },
    ];
    for (const parameters of bad) {
      expect(parseSecretaryToolDraft({ ...draft, parameters })).toEqual({
        ok: false,
        error: 'invalid tool parameters',
      });
    }
    expect(
      parseSecretaryToolDraft({ ...draft, parameters: { type: 'object', properties: {} } })
    ).toMatchObject({ ok: true });
  });

  it('拒绝未知运行时与越界超时', () => {
    expect(parseSecretaryToolDraft({ ...draft, runtime: 'ruby' })).toEqual({
      ok: false,
      error: 'invalid tool runtime',
    });
    for (const timeoutSec of [0, 301, 1.5, '30']) {
      expect(parseSecretaryToolDraft({ ...draft, timeoutSec })).toEqual({
        ok: false,
        error: 'invalid tool timeout',
      });
    }
  });
});

describe('tool files on disk', () => {
  it('tool.json 不含代码，读回来时与脚本合并成同一份草案', () => {
    const raw = renderSecretaryToolFile(draft);
    expect(raw).not.toContain('process.stdout');
    expect(JSON.parse(raw)).toMatchObject({ name: 'upper-text', runtime: 'node', readOnly: true });
    expect(parseSecretaryToolFile(raw, draft.code)).toEqual(draft);
  });

  it('坏文件读成 null', () => {
    expect(parseSecretaryToolFile('not json', 'code')).toBeNull();
    expect(parseSecretaryToolFile('{"name":"upper-text"}', 'code')).toBeNull();
    expect(parseSecretaryToolFile(renderSecretaryToolFile(draft), '')).toBeNull();
  });

  it('脚本文件名只由 runtime 决定', () => {
    expect(secretaryToolScriptFile('node')).toBe('main.mjs');
    expect(secretaryToolScriptFile('python')).toBe('main.py');
  });
});

describe('worker tool names', () => {
  it('my_ 加下划线写法，与目录名一一对应', () => {
    expect(secretaryToolId('upper-text')).toBe('my_upper_text');
    expect(secretaryToolId('upper')).toBe('my_upper');
    expect(secretaryToolDescriptor(draft)).toEqual({
      name: 'my_upper_text',
      description: draft.description,
      parameters: draft.parameters,
      readOnly: true,
    });
  });

  it('描述符列表只认确切形状，重名与外来名字整批拒绝', () => {
    const descriptor = secretaryToolDescriptor(draft);
    expect(parseSecretaryToolDescriptors([descriptor])).toEqual([descriptor]);
    expect(parseSecretaryToolDescriptors([descriptor, descriptor])).toBeNull();
    expect(parseSecretaryToolDescriptors([{ ...descriptor, name: 'bash' }])).toBeNull();
    expect(parseSecretaryToolDescriptors([{ ...descriptor, extra: 1 }])).toBeNull();
    expect(parseSecretaryToolDescriptors('nope')).toBeNull();
  });
});
