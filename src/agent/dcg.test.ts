import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDcgGuard, dcgDialect, parseDcgVerdict, withDcgExemptions } from './dcg';

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

describe('withDcgExemptions', () => {
  const hit = (ruleId: string) => async () => ({ ruleId, reason: 'r' });

  it('只放过豁免表里的具体规则，其它命中照常返回', async () => {
    const exempted = withDcgExemptions(hit('core.git:reset-hard'), ['core.git:reset-hard']);
    expect(await exempted('bash', 'git reset --hard')).toBeNull();
    const other = withDcgExemptions(hit('core.git:clean-force'), ['core.git:reset-hard']);
    expect(await other('bash', 'git clean -fd')).toEqual({
      ruleId: 'core.git:clean-force',
      reason: 'r',
    });
  });

  it('空豁免表原样返回守卫', () => {
    const guard = hit('core.git:reset-hard');
    expect(withDcgExemptions(guard, [])).toBe(guard);
  });
});

describe('parseDcgVerdict', () => {
  const robot = (fields: Record<string, unknown>) =>
    JSON.stringify({
      schema_version: 1,
      command: 'git stash drop',
      rule_id: 'core.git:stash-drop',
      reason: 'git stash drop deletes a single stash.',
      ...fields,
    });

  it('decision=deny 返回规则、原因与 deny 档', () => {
    expect(parseDcgVerdict(1, DENY)).toEqual({
      ruleId: 'core.git:reset-hard',
      reason: 'git reset --hard destroys uncommitted changes.',
      decision: 'deny',
    });
  });

  it('decision=warn 且退出码 0 也返回 warn 档命中', () => {
    expect(parseDcgVerdict(0, robot({ decision: 'warn', severity: 'medium' }))).toEqual({
      ruleId: 'core.git:stash-drop',
      reason: 'git stash drop deletes a single stash.',
      decision: 'warn',
      severity: 'medium',
    });
  });

  it('decision=ask（策略为 ask）返回 ask 档命中', () => {
    expect(parseDcgVerdict(1, robot({ decision: 'ask', severity: 'critical' }))).toMatchObject({
      ruleId: 'core.git:stash-drop',
      decision: 'ask',
      severity: 'critical',
    });
  });

  it('带出 explanation 与 matched_span 对应的命令片段（按 UTF-8 字节偏移）', () => {
    const hit = parseDcgVerdict(
      1,
      robot({
        decision: 'deny',
        severity: 'high',
        command: 'echo 中 && git stash drop',
        explanation: 'stash entries become unreferenced',
        matched_span: [12, 26],
      })
    );
    expect(hit).toMatchObject({
      severity: 'high',
      explanation: 'stash entries become unreferenced',
      matched: 'git stash drop',
    });
  });

  it('未知 severity、坏 matched_span 不带出，但不影响命中', () => {
    const hit = parseDcgVerdict(
      1,
      robot({ decision: 'deny', severity: 'huge', matched_span: [9, 2] })
    );
    expect(hit).toEqual({
      ruleId: 'core.git:stash-drop',
      reason: 'git stash drop deletes a single stash.',
      decision: 'deny',
    });
  });

  it('放行、无 decision、坏 JSON、缺字段、被杀（无退出码）一律 null', () => {
    expect(parseDcgVerdict(0, JSON.stringify({ decision: 'allow' }))).toBeNull();
    expect(parseDcgVerdict(0, robot({ decision: 'allow' }))).toBeNull();
    expect(parseDcgVerdict(1, robot({}))).toBeNull();
    expect(parseDcgVerdict(1, 'not json')).toBeNull();
    expect(parseDcgVerdict(1, 'null')).toBeNull();
    expect(parseDcgVerdict(1, JSON.stringify({ decision: 'deny' }))).toBeNull();
    expect(parseDcgVerdict(1, robot({ decision: 'warn', reason: '' }))).toBeNull();
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
