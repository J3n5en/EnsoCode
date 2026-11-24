import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type CommandGuard,
  createDcgGuard,
  DCG_INVALID_VERDICT_RULE_ID,
  dcgDialect,
  deletesTempRoot,
  isBlockingGuardHit,
  isTempSubpathExemptibleHit,
  parseDcgVerdict,
  stripSafeTempSubpathDeletes,
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

/** 派出会话部署完清理临时文件时被 temp-root-delete 误拦的原始命令（会话 10cb0eab） */
const DEPLOY_CLEANUP_COMMANDS = [
  String.raw`sleep 15; ssh -o BatchMode=yes ali 'pm2 jlist | python3 -c "import json,sys; [print(p[\"name\"],p[\"pm2_env\"][\"status\"],p[\"pm2_env\"][\"restart_time\"]) for p in json.load(sys.stdin) if p[\"name\"]==\"enso-relay\"]"; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/healthz; rm -rf /tmp/enso-relay-upload-59dc0c2; ls -d /tmp/enso-relay-upload* 2>/dev/null; ls /opt/enso-relay | grep -c "\.new$"'; rm -rf /tmp/ali-deploy /tmp/ali-deploy-build.log; git checkout -- packages/relay-go/frontend && git clean -fdq packages/relay-go/frontend -e desk-bundle; rm -rf packages/relay-go/frontend/desk-bundle; git status --short; git rev-parse HEAD`,
  String.raw`sleep 15; ssh -o BatchMode=yes ali 'pm2 jlist | python3 -c "import json,sys; [print(p[\"name\"],p[\"pm2_env\"][\"status\"],p[\"pm2_env\"][\"restart_time\"]) for p in json.load(sys.stdin) if p[\"name\"]==\"enso-relay\"]"; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/healthz; cd /tmp/enso-relay-upload-59dc0c2 && rm -f part-* enso-relay-linux-amd64 check.sh && cd / && rmdir /tmp/enso-relay-upload-59dc0c2; ls -d /tmp/enso-relay-upload* 2>/dev/null; echo remaining-new=$(ls /opt/enso-relay | grep -c "\.new$")'`,
  String.raw`ssh -o BatchMode=yes ali 'pm2 jlist | python3 -c "import json,sys; [print(p[\"name\"],p[\"pm2_env\"][\"status\"],p[\"pm2_env\"][\"restart_time\"]) for p in json.load(sys.stdin) if p[\"name\"]==\"enso-relay\"]"; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/healthz; cd /tmp/enso-relay-upload-59dc0c2 && rm -f part-* enso-relay-linux-amd64 check.sh && cd .. && rmdir enso-relay-upload-59dc0c2; ls -d /tmp/enso-relay-upload* 2>/dev/null; echo remaining-new=$(ls /opt/enso-relay | grep -c "\.new$")'`,
];

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
      // 切进 Temp 根再删当前目录 / 通配
      'cd /tmp && rm -rf *',
      'cd "$TMPDIR"; rm -rf .',
      'Set-Location $env:TEMP; Remove-Item * -Recurse',
      // 路径穿越回 Temp 根、find 删除 Temp 根、shell heredoc 删 Temp 根
      'rm -rf /tmp/foo/..',
      'rm -rf /tmp/foo/../*',
      'find /tmp -maxdepth 1 -delete',
      'find "$TMPDIR" -exec rm -rf {} +',
      "sh <<'EOF'\nrm -rf /tmp/*\nEOF",
      '(cd /tmp && rm -rf *)',
      '/bin/sh <<EOF\nrm -rf /tmp/*\nEOF',
      'echo "<<EOF"\nrm -rf /tmp/*\nEOF',
      'cd /tmp && rm -rf $(ls)',
      'cd "$TMPDIR" && rm -rf "$PWD"/*',
      'cd /tmp && rm -rf ~+/*',
      'cd /tmp && find -delete',
      'rm -rf /tmp/{,}',
      'rm -rf /private/tmp/',
      'rm -rf "$TMPDIR"',
      // 根下一层完全由变量展开决定：变量为空即退化成删 Temp 根
      'rm -rf /tmp/$X',
      'rm -rf "$TMPDIR/$name"',
      // 子 shell 脚本里切进 Temp 根再删
      'bash -c "cd /tmp && rm -rf *"',
      // 远端按 POSIX 语义判：远端的 /tmp 同样是共享 Temp 根
      "ssh ali 'rm -rf /tmp/*'",
      "ssh -o BatchMode=yes -p 22 ali 'cd /tmp && rm -rf *'",
      'ssh ali rm -rf /tmp',
      'cd /tmp && bash -c "rm -rf *"',
      `sh -c 'rm -rf "$1"' _ /tmp`,
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
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 的 ${TMPDIR} 具体子目录写法
      'rm -rf "${TMPDIR}/sub/dir"',
      'rm -rf ./tmp/*',
      'rm -rf build/tmp/*',
      'ls /tmp',
      'Write-Output "remove temp files"',
      // 跨语句无关引用：前句删具体子目录、后句切到 /tmp 运行脚本（真实误伤场景）
      'rm -rf /tmp/ohg-old && mkdir -p /tmp/ohg-old/dist\ncd /tmp && node probe-old.mjs',
      'rm -rf ./build && ls /tmp',
      // 切到 /tmp 后只删明确的具体子目录（无通配、非 . / ..）
      'cd /tmp && rm -rf ohg-old',
      // 非 shell 的 heredoc 正文或注释里出现 rm 和 /tmp 不误判
      "python3 - <<'PY'\n# rm something\np = '/tmp/'\nPY",
      "cat <<'EOF' > /tmp/verify.mjs\n// rm old files\nconst dir = '/tmp';\nEOF",
      // 注释里的 rm 不算删除动词
      '# rm old files\nls /tmp',
      // find 只作用于具体子目录
      'find /tmp/my-run -delete',
      // 只删明确子路径；同一段远端/子 shell 脚本里别的命令带根下通配不算删根
      ...DEPLOY_CLEANUP_COMMANDS,
      'rm -rf /tmp/ali-deploy /tmp/ali-deploy-build.log',
      "ssh ali 'rm -rf /tmp/enso-relay-upload-59dc0c2'",
      "bash -c 'rm -rf /tmp/a; ls -d /tmp/a*'",
      // 远端命令不继承本机 cwd
      'cd /tmp && ssh ali "rm -rf old-build"',
    ]) {
      expect(deletesTempRoot(command), command).toBe(false);
    }
  });

  it('本机 Temp 根的绝对路径只对本机命令生效，不套用到 ssh 远端命令', () => {
    const tmpDir = '/var/folders/ab/cd/T';
    expect(deletesTempRoot(`rm -rf ${tmpDir}`, { tmpDir })).toBe(true);
    expect(deletesTempRoot(`ssh ali 'rm -rf ${tmpDir}'`, { tmpDir })).toBe(false);
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

  it('放行的明确 Temp 子路径不影响内层守卫对 home、项目目录与根目录的拦截', async () => {
    const inner: CommandGuard = async (_tool, command) =>
      /\brm\b/.test(command) ? { ruleId: 'core.filesystem:rm-rf-root-home', reason: 'x' } : null;
    const guard = withTempRootGuard(inner);
    for (const command of ['rm -rf ~', 'rm -rf /', 'rm -rf /Users/alice/project']) {
      expect((await guard('bash', command))?.ruleId, command).toBe(
        'core.filesystem:rm-rf-root-home'
      );
    }
  });

  it('没装 dcg 也生效；非命令工具不检查', async () => {
    const guard = withTempRootGuard(undefined);
    expect((await guard('powershell', 'Remove-Item $env:TEMP\\*'))?.ruleId).toBe(TEMP_ROOT_RULE_ID);
    expect(await guard('powershell', 'git reset --hard')).toBeNull();
    expect(await guard('edit', 'Remove-Item $env:TEMP\\*')).toBeNull();
  });
});

describe('stripSafeTempSubpathDeletes 与 isTempSubpathExemptibleHit', () => {
  it('识别明确临时子目录删除（POSIX 与 PowerShell），并保留后续非删除语句供复检', () => {
    expect(stripSafeTempSubpathDeletes('bash', 'rm -rf /tmp/enso-verify-123')).toEqual({
      remaining: '',
    });
    expect(
      stripSafeTempSubpathDeletes('bash', 'rm -rf "$TMPDIR/foo" && git reset --hard', {
        envTmpDir: '/var/folders/aa/bb/T',
      })
    ).toEqual({
      remaining: 'git reset --hard',
    });
    expect(
      stripSafeTempSubpathDeletes('powershell', 'Remove-Item "$env:TEMP\\my-dir" -Recurse -Force')
    ).toEqual({
      remaining: '',
    });
  });

  it('Temp 根、通配、变量逃逸、.. 穿越与非临时目标一律返回 null', () => {
    for (const [tool, cmd] of [
      ['bash', 'rm -rf /tmp/*'],
      ['bash', 'rm -rf /tmp/enso-*'],
      ['bash', 'rm -rf /tmp/x/{..,b}/*'],
      ['bash', 'rm -rf /tmp/x/.*/*'],
      ['bash', 'rm -rf /tmp/x/*'],
      ['bash', 'rm -rf "$TMPDIR/$SUB"'],
      ['bash', 'export TMPDIR=$HOME; rm -rf "$TMPDIR/proj"'],
      ['bash', 'TMPDIR=/ rm -rf "$TMPDIR/etc"'],
      ['bash', 'rm -rf /tmp/a&find -delete'],
      ['bash', 'rm -rf /tmp/a\npython3 <<EOF\nos.system("rm -rf ~")\nEOF'],
      ['bash', 'ln -s ~ /tmp/x && rm -rf /tmp/x/sub'],
      ['bash', 'rm -rf /tmp/foo/..'],
      ['bash', 'rm -rf /'],
      ['bash', 'rm -rf /tmp/foo /etc'],
      ['bash', 'rm -rf "$TMPDIR/foo" && rm -rf /'],
      ['powershell', 'Remove-Item "$env:TEMP\\*" -Recurse -Force'],
      ['powershell', 'Remove-Item $env:TEMP\\x,C:\\Windows -Recurse -Force'],
      ['powershell', 'Remove-Item "$env:TEMP\\my-dir" -Include *.txt -Recurse'],
    ] as const) {
      expect(stripSafeTempSubpathDeletes(tool, cmd), cmd).toBeNull();
    }
    // 当运行环境未设置 TMPDIR 时（如 Linux 默认为空），$TMPDIR/usr 会展开成 /usr，绝不放行
    expect(
      stripSafeTempSubpathDeletes('bash', 'rm -rf "$TMPDIR/usr"', { envTmpDir: '' })
    ).toBeNull();
    // sessionOnly 模式：只认会话专属临时目录，普通 /tmp/foo 不放行
    const sessionDir = '/var/folders/aa/bb/T/enso-session-temp-501/sess-1';
    expect(
      stripSafeTempSubpathDeletes('bash', 'rm -rf /tmp/foo', {
        sessionTempDir: sessionDir,
        sessionOnly: true,
      })
    ).toBeNull();
    expect(
      stripSafeTempSubpathDeletes('bash', `rm -rf "${sessionDir}/work"`, {
        sessionTempDir: sessionDir,
        sessionOnly: true,
      })
    ).toEqual({ remaining: '' });
  });

  it('只对 deny 档文件系统删除规则生效；root-home 仅允许 sessionOnly，绝不绕过 ask 或非删除高危规则', () => {
    expect(
      isTempSubpathExemptibleHit({ ruleId: 'core.filesystem:rm-rf-general', reason: 'r' })
    ).toBe('temp-subpath');
    expect(
      isTempSubpathExemptibleHit({ ruleId: 'core.filesystem:rm-rf-root-home', reason: 'r' })
    ).toBe('session-only');
    expect(
      isTempSubpathExemptibleHit({
        ruleId: 'core.filesystem:rm-rf-general',
        reason: 'r',
        decision: 'ask',
      })
    ).toBeNull();
    expect(isTempSubpathExemptibleHit({ ruleId: TEMP_ROOT_RULE_ID, reason: 'r' })).toBeNull();
    expect(
      isTempSubpathExemptibleHit({ ruleId: 'core.filesystem:credential-file-write', reason: 'r' })
    ).toBeNull();
    expect(isTempSubpathExemptibleHit({ ruleId: 'core.git:reset-hard', reason: 'r' })).toBeNull();
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

  it('failClosedOnError=true 时，超时或无法执行按 ask 兜底，不误放行', async () => {
    const slow = script('slow-recheck', 'sleep 2');
    const timedOut = await createDcgGuard(slow, 80)('bash', 'git reset --hard', undefined, {
      failClosedOnError: true,
    });
    expect(timedOut?.ruleId).toBe(DCG_INVALID_VERDICT_RULE_ID);
    expect(timedOut?.decision).toBe('ask');
    const missing = await createDcgGuard(join(dir, 'missing'))(
      'bash',
      'git reset --hard',
      undefined,
      { failClosedOnError: true }
    );
    expect(missing?.ruleId).toBe(DCG_INVALID_VERDICT_RULE_ID);
    expect(missing?.decision).toBe('ask');
  });
});
