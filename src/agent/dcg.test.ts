import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createDcgGuard,
  DCG_INVALID_VERDICT_RULE_ID,
  dcgDialect,
  deletesTempRoot,
  isBlockingGuardHit,
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

  it('记忆豁免绝不能绕过 ask、不可豁免内置规则，也不吞掉 warn 提醒', async () => {
    const askGuard = withDcgExemptions(
      async () => ({ ruleId: 'core.git:reset-hard', reason: 'r', decision: 'ask' as const }),
      ['core.git:reset-hard']
    );
    expect(await askGuard('bash', 'git reset --hard')).toEqual({
      ruleId: 'core.git:reset-hard',
      reason: 'r',
      decision: 'ask',
    });

    const invalidGuard = withDcgExemptions(
      async () => ({
        ruleId: DCG_INVALID_VERDICT_RULE_ID,
        reason: 'bad',
        decision: 'ask' as const,
      }),
      [DCG_INVALID_VERDICT_RULE_ID]
    );
    expect(await invalidGuard('bash', 'git reset --hard')).toMatchObject({
      ruleId: DCG_INVALID_VERDICT_RULE_ID,
      decision: 'ask',
    });

    const warnGuard = withDcgExemptions(
      async () => ({ ruleId: 'core.git:stash-drop', reason: 'r', decision: 'warn' as const }),
      ['core.git:stash-drop']
    );
    expect(await warnGuard('bash', 'git stash drop')).toEqual({
      ruleId: 'core.git:stash-drop',
      reason: 'r',
      decision: 'warn',
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

  it('仅 exitCode=0 且 decision=allow，或被杀（无退出码）返回 null', () => {
    expect(parseDcgVerdict(0, JSON.stringify({ decision: 'allow' }))).toBeNull();
    expect(parseDcgVerdict(0, robot({ decision: 'allow' }))).toBeNull();
    expect(parseDcgVerdict(null, DENY)).toBeNull();
  });

  it('未知或格式错的 decision、坏 JSON、缺字段或非零退出码一律按拦截/确认处理，绝不默认放行', () => {
    for (const [code, stdout] of [
      [0, robot({ decision: 'block' })],
      [1, robot({ decision: 'confirm' })],
      [0, robot({ decision: 123 })],
      [0, robot({ decision: '' })],
      [1, robot({})],
      [0, 'not json'],
      [1, 'not json'],
      [0, 'null'],
      [0, '[]'],
      [1, ''],
      [1, JSON.stringify({ decision: 'allow' })],
      [2, robot({ decision: 'allow' })],
      [0, robot({ decision: 'warn', reason: '' })],
      [0, JSON.stringify({ decision: 'warn' })],
    ] as const) {
      const hit = parseDcgVerdict(code, stdout);
      expect(hit, `${code}:${stdout}`).not.toBeNull();
      expect(isBlockingGuardHit(hit!), `${code}:${stdout}`).toBe(true);
      expect(hit!.decision, `${code}:${stdout}`).toBe('ask');
    }

    const incompleteDeny = parseDcgVerdict(1, JSON.stringify({ decision: 'deny' }));
    expect(incompleteDeny).toMatchObject({
      ruleId: DCG_INVALID_VERDICT_RULE_ID,
      decision: 'deny',
    });
    const incompleteAsk = parseDcgVerdict(1, JSON.stringify({ decision: 'ask', rule_id: 'r.a:b' }));
    expect(incompleteAsk).toMatchObject({
      ruleId: 'r.a:b',
      decision: 'ask',
    });
    expect(incompleteAsk?.reason).toBeTruthy();
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
