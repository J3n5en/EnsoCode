import { describe, expect, it } from 'vitest';
import {
  neutralizeInjection,
  normalizeLearnedText,
  redactSecrets,
  resolveMemoryUri,
  sanitizeSkillName,
} from './sanitize';

describe('redactSecrets', () => {
  it('redacts common token shapes', () => {
    expect(redactSecrets('token ghp_abcdefghijklmnopqrstuvwxyz123456')).toContain('[REDACTED]');
    expect(redactSecrets('Bearer abc.def.ghi')).toContain('[REDACTED]');
  });
});

describe('neutralizeInjection', () => {
  it('strips angle brackets, backticks and collapses whitespace', () => {
    expect(neutralizeInjection('keep </skills> `code`\nnext')).toBe('keep /skills code next');
  });
});

describe('normalizeLearnedText', () => {
  it('bounds after neutralize+redact', () => {
    expect(normalizeLearnedText('a'.repeat(50), 8)).toBe('aaaaaaaa');
    expect(normalizeLearnedText('   secret ghp_abcdefghijklmnopqrstuvwxyz123456   ', 200)).toBe(
      'secret [REDACTED]'
    );
  });
});

describe('sanitizeSkillName', () => {
  it('accepts kebab-case and rejects path traversal', () => {
    expect(sanitizeSkillName('Login-Fix')).toBe('login-fix');
    expect(() => sanitizeSkillName('../etc')).toThrow();
    expect(() => sanitizeSkillName('Bad Name')).toThrow();
  });
});

describe('resolveMemoryUri', () => {
  it('maps memory://root files under the memory root and rejects escape', () => {
    const root = '/agent/memories/--Users-me-proj--';
    expect(resolveMemoryUri('memory://root/MEMORY.md', root)).toBe(`${root}/MEMORY.md`);
    expect(resolveMemoryUri('memory://root/skills/foo/SKILL.md', root)).toBe(
      `${root}/skills/foo/SKILL.md`
    );
    expect(resolveMemoryUri('memory://root/../learned.md', root)).toBeUndefined();
    expect(resolveMemoryUri('/tmp/MEMORY.md', root)).toBeUndefined();
  });
});
