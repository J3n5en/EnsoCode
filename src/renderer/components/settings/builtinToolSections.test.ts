import { BUILTIN_TOOLS } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { builtinToolsInSection, TOOL_SECTION, TOOL_SECTIONS } from './builtinToolSections';

describe('builtinToolSections', () => {
  it('每个内置工具恰好属于一个分节', () => {
    const ids = BUILTIN_TOOLS.map((tool) => tool.id).sort();
    expect(Object.keys(TOOL_SECTION).sort()).toEqual(ids);
    const seen = TOOL_SECTIONS.flatMap((section) =>
      builtinToolsInSection(BUILTIN_TOOLS, section.id).map((tool) => tool.id)
    );
    expect(new Set(seen).size).toBe(ids.length);
    expect(seen.sort()).toEqual(ids);
  });
});
