import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDcgGuard, dcgDialect, parseDcgVerdict } from './dcg';

const DENY = JSON.stringify({
  decision: 'deny',
  rule_id: 'core.git:reset-hard',
  pack_id: 'core.git',
  reason: 'git reset --hard destroys uncommitted changes.',
});

describe('dcgDialect', () => {
  it('bash 用 posix，powershell 用 ps，其余工具不检查', () => {
    expect(dcgDialect('bash')).toBe('posix');
    expect(dcgDialect('powershell')).toBe('ps');
    expect(dcgDialect('edit')).toBeNull();
  });
});

describe('parseDcgVerdict', () => {
  it('退出码 1 且 decision=deny 返回规则与原因', () => {
    expect(parseDcgVerdict(1, DENY)).toEqual({
      ruleId: 'core.git:reset-hard',
      reason: 'git reset --hard destroys uncommitted changes.',
    });
  });

  it('放行、坏 JSON、缺字段、其它退出码一律放行', () => {
    expect(parseDcgVerdict(0, JSON.stringify({ decision: 'allow' }))).toBeNull();
    expect(parseDcgVerdict(1, 'not json')).toBeNull();
    expect(parseDcgVerdict(1, JSON.stringify({ decision: 'deny' }))).toBeNull();
    expect(parseDcgVerdict(2, DENY)).toBeNull();
    expect(parseDcgVerdict(null, DENY)).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('createDcgGuard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enso-dcg-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const script = (name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const argsLog = join(dir, 'args.txt');

  it('按工具方言调用 robot test，命中返回原因', async () => {
    const bin = script('deny', `printf '%s\\n' "$@" > '${argsLog}'\necho '${DENY}'\nexit 1`);
    const hit = await createDcgGuard(bin)('powershell', 'Remove-Item -Recurse x');
    expect(hit?.ruleId).toBe('core.git:reset-hard');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(argsLog, 'utf8').trim().split('\n')).toEqual([
      '--robot',
      'test',
      '--dialect',
      'ps',
      'Remove-Item -Recurse x',
    ]);
  });

  it('放行、非命令工具、缺二进制、超时都返回 null', async () => {
    const allow = script('allow', `echo '{"decision":"allow"}'\nexit 0`);
    expect(await createDcgGuard(allow)('bash', 'ls')).toBeNull();
    const deny = script('deny2', `echo '${DENY}'\nexit 1`);
    expect(await createDcgGuard(deny)('edit', 'x')).toBeNull();
    expect(await createDcgGuard(join(dir, 'missing'))('bash', 'ls')).toBeNull();
    const slow = script('slow', `sleep 5\necho '${DENY}'\nexit 1`);
    expect(await createDcgGuard(slow, 100)('bash', 'ls')).toBeNull();
  });
});
