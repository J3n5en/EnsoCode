import { BUILTIN_TOOLS } from '@shared/types/builtinTools';
import { describe, expect, it } from 'vitest';
import {
  isSecretaryToolAllowed,
  SECRETARY_FORCED_DISABLED_TOOLS,
  SECRETARY_OPS,
  SECRETARY_TOOL_ALLOWLIST,
} from './tools';

describe('secretary tool allowlist', () => {
  it('只含 14 个秘书工具与通用只读工具，核心工具与写工具不在其中', () => {
    expect([...SECRETARY_TOOL_ALLOWLIST].sort()).toEqual(
      [
        ...SECRETARY_OPS,
        'ask_user',
        'web_search',
        'web_fetch',
        'memory_search',
        'memory_capture',
        'memory_crystallize',
        'memory_delete',
      ].sort()
    );
    for (const banned of ['bash', 'read', 'grep', 'find', 'ls', 'apply_patch', 'codemode'])
      expect(SECRETARY_TOOL_ALLOWLIST.has(banned), banned).toBe(false);
  });

  it('强制禁用列表关掉除 ask_user / web / memory 之外的全部分组', () => {
    const allowed = new Set(['ask_user', 'web', 'memory']);
    for (const tool of BUILTIN_TOOLS) {
      if (allowed.has(tool.id))
        expect(SECRETARY_FORCED_DISABLED_TOOLS, tool.id).not.toContain(tool.id);
      else expect(SECRETARY_FORCED_DISABLED_TOOLS, tool.id).toContain(tool.id);
    }
    expect(SECRETARY_FORCED_DISABLED_TOOLS).toEqual(
      expect.arrayContaining(['isolated_sandbox', 'workspace_write', 'goal'])
    );
  });

  it('插件工具只按 Main 本次下发的名字放行，不认 plugin_ 前缀', () => {
    expect(isSecretaryToolAllowed('plugin_enso-tgclient__tg_send_message')).toBe(false);
    expect(isSecretaryToolAllowed('plugin_x__evil', new Set(['plugin_x__evil']))).toBe(true);
    expect(isSecretaryToolAllowed('plugin_x__evil', new Set(['plugin_x__echo']))).toBe(false);
  });
});
