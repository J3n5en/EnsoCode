import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createDcgGuard,
  dcgDialect,
  deletesTempRoot,
  parseDcgVerdict,
  TEMP_ROOT_RULE_ID,
  withDcgExemptions,
  withTempRootGuard,
} from './dcg';

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

  it('高危底线规则即使被传入豁免表也绝不放行', async () => {
    const rootRm = withDcgExemptions(hit('core.filesystem:rm-rf-root-home'), [
      'core.filesystem:rm-rf-root-home',
    ]);
    expect(await rootRm('bash', 'rm -rf /')).toEqual({
      ruleId: 'core.filesystem:rm-rf-root-home',
      reason: 'r',
    });
    const pipeSh = withDcgExemptions(hit('heredoc.posix:pipeline-consumer'), [
      'heredoc.posix:pipeline-consumer',
    ]);
    expect(await pipeSh('bash', 'curl x | sh')).toEqual({
      ruleId: 'heredoc.posix:pipeline-consumer',
      reason: 'r',
    });
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

describe('deletesTempRoot', () => {
  it('删除系统 Temp 根或根下通配视为命中', () => {
    for (const command of [
      'Remove-Item $env:TEMP\\* -Recurse -Force',
      'Remove-Item -Recurse -Force "$env:TEMP\\*"',
      'Remove-Item $env:TMP -Recurse',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: PowerShell 的 ${env:TEMP} 写法
      'Remove-Item "${env:TEMP}/*.*" -Force',
      'rm -r -fo $env:TEMP/*',
      'Get-ChildItem $env:TEMP | Remove-Item -Recurse -Force',
      'Get-ChildItem -Path $env:TEMP -Recurse | ForEach-Object { Remove-Item $_.FullName }',
      'cmd /c del /s /q %TEMP%\\*',
      'cmd /c rd /s /q "%LOCALAPPDATA%\\Temp"',
      'Remove-Item "$env:LOCALAPPDATA\\Temp\\*" -Recurse',
      "Remove-Item 'C:\\Users\\alice\\AppData\\Local\\Temp\\*' -Recurse -Force",
      'Remove-Item ([System.IO.Path]::GetTempPath() + "*") -Recurse',
      'Remove-Item (Join-Path $env:TEMP "*") -Recurse',
      'Remove-Item ~\\AppData\\Local\\Temp\\* -Recurse',
      'Clear-RecycleBin; ri $env:temp\\* -r',
      // 根下按通配删一批：会连带删掉别的程序的同类文件
      'Remove-Item $env:TEMP\\*.tmp -Force',
      'Remove-Item "$env:TEMP\\tmp*" -Recurse',
      'cmd /c "del /q %TEMP%\\*"',
      // macOS / Linux 的 Temp 根同样只读不删
      'rm -rf /tmp/*',
      'rm -rf /tmp',
      'rm -rf /private/tmp/enso-*',
      'rm -rf /var/tmp/*',
      'rm -rf $TMPDIR/*',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 的 ${TMPDIR} 写法
      'rm -rf "${TMPDIR}"*',
    ]) {
      expect(deletesTempRoot(command), command).toBe(true);
    }
  });

  it('会话子目录内删除、只读访问与无关命令放行', () => {
    for (const command of [
      'Remove-Item $env:TEMP\\enso\\abc -Recurse -Force',
      'Remove-Item "C:\\Users\\alice\\AppData\\Local\\Temp\\enso\\abc\\run.ps1"',
      'rm -r -fo "$env:TEMP/enso/abc/*"',
      'Get-ChildItem $env:TEMP',
      'New-Item -ItemType Directory $env:TEMP\\enso\\x',
      'Set-Content $env:TEMP\\enso\\x\\a.txt hi',
      'Remove-Item .\\build -Recurse',
      'rm -rf /tmp/x',
      'rm -rf "$TMPDIR/enso-x"',
      'rm -rf ./tmp/*',
      'rm -rf build/tmp/*',
      'ls /tmp',
      'Write-Output "remove temp files"',
    ]) {
      expect(deletesTempRoot(command), command).toBe(false);
    }
  });
});

describe('withTempRootGuard', () => {
  it('Temp 根删除先于 dcg 命中，其余交给内层守卫', async () => {
    const inner = async (_tool: string, command: string) =>
      command === 'git reset --hard' ? { ruleId: 'core.git:reset-hard', reason: 'x' } : null;
    const guard = withTempRootGuard(inner);
    expect((await guard('powershell', 'Remove-Item $env:TEMP\\* -Recurse'))?.ruleId).toBe(
      TEMP_ROOT_RULE_ID
    );
    expect(await guard('powershell', 'Remove-Item $env:TEMP\\enso\\a -Recurse')).toBeNull();
    expect((await guard('bash', 'git reset --hard'))?.ruleId).toBe('core.git:reset-hard');
  });

  it('没装 dcg 也生效；非命令工具不检查', async () => {
    const guard = withTempRootGuard(undefined);
    expect((await guard('powershell', 'Remove-Item $env:TEMP\\*'))?.ruleId).toBe(TEMP_ROOT_RULE_ID);
    expect(await guard('powershell', 'git reset --hard')).toBeNull();
    expect(await guard('edit', 'Remove-Item $env:TEMP\\*')).toBeNull();
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
