import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InlineExtension, Skill } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { skillChainExtension } from './skillChainExtension';

type InputHandler = (event: { text: string }) => unknown;

function handlerOf(extension: InlineExtension): InputHandler {
  let handler: InputHandler | undefined;
  const factory = typeof extension === 'function' ? extension : extension.factory;
  factory({
    on: vi.fn((event: string, value: InputHandler) => {
      if (event === 'input') handler = value;
    }),
  } as never);
  if (!handler) throw new Error('input handler not registered');
  return handler;
}

function skill(root: string, name: string): Skill {
  const baseDir = join(root, name);
  mkdirSync(baseDir);
  const filePath = join(baseDir, 'SKILL.md');
  writeFileSync(filePath, `---\nname: ${name}\ndescription: d\n---\n\n# ${name}\n`);
  return { name, filePath, baseDir } as Skill;
}

describe('skillChainExtension', () => {
  it('展开开头连续的多个 /skill:', () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-chain-'));
    const skills = [skill(root, 'a'), skill(root, 'b')];
    const handler = handlerOf(skillChainExtension(() => skills));
    const result = handler({ text: '/skill:a /skill:b 做事' }) as { action: string; text: string };
    expect(result.action).toBe('transform');
    expect(result.text).toBe(
      `<skill name="a" location="${skills[0]!.filePath}">\nReferences are relative to ${skills[0]!.baseDir}.\n\n# a\n</skill>\n\n` +
        `<skill name="b" location="${skills[1]!.filePath}">\nReferences are relative to ${skills[1]!.baseDir}.\n\n# b\n</skill>\n\n做事`
    );
  });

  it('非 /skill: 开头或未知 skill 不处理', () => {
    const handler = handlerOf(skillChainExtension(() => []));
    expect(handler({ text: '做事' })).toBeUndefined();
    expect(handler({ text: '/skill:x 做事' })).toBeUndefined();
  });
});
