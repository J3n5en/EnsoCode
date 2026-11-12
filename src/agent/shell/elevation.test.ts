import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  buildElevatedCommand,
  ELEVATE_DECLINED_MARKER,
  ELEVATE_TIMED_OUT_MARKER,
  ELEVATE_UNAVAILABLE_MARKER,
} from '@shared/elevation';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareElevation, withElevation } from './elevation';

const posix = process.platform !== 'win32';
const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'enso-elevate-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Result = {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
};

function fakeBash(respond?: (params: Record<string, unknown>) => Result) {
  const calls: Record<string, unknown>[] = [];
  const definition = {
    name: 'bash',
    label: 'bash',
    description: 'Execute a bash command.',
    promptGuidelines: ['keep me'],
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    execute: async (_id: string, params: Record<string, unknown>) => {
      calls.push(params);
      return respond ? respond(params) : { content: [{ type: 'text', text: 'ok' }] };
    },
  } as unknown as ToolDefinition;
  return { definition, calls };
}

const opts = { sudoPath: '/usr/bin/sudo', askpassPath: '/x/askpass.sh' };

async function run(tool: ToolDefinition, params: Record<string, unknown>): Promise<Result> {
  return (await tool.execute(
    't1',
    params as never,
    undefined,
    undefined,
    undefined as never
  )) as Result;
}

describe('prepareElevation', () => {
  const env = { ENSO_ELEVATE_ASKPASS: '/x/askpass' };
  it('Main 给了 helper 且有 sudo 时可用', () => {
    expect(prepareElevation(env, () => true, 'darwin')).toEqual({
      sudoPath: '/usr/bin/sudo',
      askpassPath: '/x/askpass',
    });
    expect(prepareElevation(env, (p) => p !== '/usr/bin/sudo', 'linux')?.sudoPath).toBe(
      '/bin/sudo'
    );
  });

  it('缺 helper、缺 sudo 或 Windows 时不可用', () => {
    expect(prepareElevation({}, () => true, 'darwin')).toBeNull();
    expect(prepareElevation(env, (p) => p === '/x/askpass', 'darwin')).toBeNull();
    expect(prepareElevation(env, () => true, 'win32')).toBeNull();
  });
});

describe.runIf(posix)('buildElevatedCommand', () => {
  it('经 sudo -k -A 执行原命令，引号与特殊字符原样到达', () => {
    const dir = tempDir();
    const sudo = path.join(dir, 'sudo');
    const askpass = path.join(dir, 'askpass.sh');
    writeFileSync(
      sudo,
      [
        '#!/bin/sh',
        '[ "$1 $2 $3" = "-k -A --" ] || { echo "bad flags: $*" >&2; exit 2; }',
        'pw=$("$SUDO_ASKPASS" "Password:") || exit 1',
        '[ "$pw" = "pw" ] || exit 1',
        'shift 3',
        'exec "$@"',
        '',
      ].join('\n'),
      { mode: 0o700 }
    );
    writeFileSync(askpass, "#!/bin/sh\nprintf 'pw\\n'\n", { mode: 0o700 });
    const command = `printf '%s|' "a b" 'c"d' "e'f" && echo $((1+1))`;
    const out = execFileSync('/bin/bash', [
      '-c',
      buildElevatedCommand(command, { sudoPath: sudo, askpassPath: askpass }),
    ]);
    expect(out.toString()).toBe(`a b|c"d|e'f|2\n`);
  });
});

describe('withElevation', () => {
  it('schema 增加 elevated 参数，并追加使用守则', () => {
    const tool = withElevation(fakeBash().definition, { ...opts, unattended: () => false });
    const props = (tool.parameters as unknown as { properties: Record<string, { type: string }> })
      .properties;
    expect(props.elevated?.type).toBe('boolean');
    expect(props.command?.type).toBe('string');
    expect(tool.promptGuidelines?.[0]).toBe('keep me');
    expect(tool.promptGuidelines?.some((line) => /elevated: true/.test(line))).toBe(true);
  });

  it('未请求提权时参数原样下传', async () => {
    const { definition, calls } = fakeBash();
    const tool = withElevation(definition, { ...opts, unattended: () => false });
    await run(tool, { command: 'ls', timeout: 5 });
    expect(calls).toEqual([{ command: 'ls', timeout: 5 }]);
  });

  it('elevated: true 改写为 sudo 命令，其它参数保留', async () => {
    const { definition, calls } = fakeBash();
    const tool = withElevation(definition, { ...opts, unattended: () => false });
    await run(tool, { command: 'id -u', elevated: true, timeout: 30 });
    expect(calls).toEqual([{ command: buildElevatedCommand('id -u', opts), timeout: 30 }]);
  });

  it('模型自己写了 sudo 前缀时拒绝且不执行', async () => {
    const { definition, calls } = fakeBash();
    const tool = withElevation(definition, { ...opts, unattended: () => false });
    const result = await run(tool, { command: '  sudo apt install x', elevated: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/sudo/);
    expect(calls).toHaveLength(0);
  });

  it('无人值守时拒绝提权且不执行', async () => {
    const { definition, calls } = fakeBash();
    const tool = withElevation(definition, { ...opts, unattended: () => true });
    const result = await run(tool, { command: 'id -u', elevated: true });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('用户拒绝或超时：返回明确结论与结构化状态', async () => {
    const declined = withElevation(
      fakeBash(() => ({
        content: [
          {
            type: 'text',
            text: `${ELEVATE_DECLINED_MARKER}\nsudo: no password was provided\n\nCommand exited with code 1`,
          },
        ],
        isError: true,
      })).definition,
      { ...opts, unattended: () => false }
    );
    const a = await run(declined, { command: 'id -u', elevated: true });
    expect(a.isError).toBe(true);
    expect(a.details?.elevation).toBe('declined');
    expect(a.content[0]?.text).not.toContain(ELEVATE_DECLINED_MARKER);
    expect(a.content[0]?.text).toMatch(/did not run/);

    const timedOut = withElevation(
      fakeBash(() => ({
        content: [
          { type: 'text', text: `${ELEVATE_TIMED_OUT_MARKER}\nCommand exited with code 1` },
        ],
        isError: true,
      })).definition,
      { ...opts, unattended: () => false }
    );
    const b = await run(timedOut, { command: 'id -u', elevated: true });
    expect(b.isError).toBe(true);
    expect(b.details?.elevation).toBe('timed_out');

    const unavailable = withElevation(
      fakeBash(() => ({
        content: [
          { type: 'text', text: `${ELEVATE_UNAVAILABLE_MARKER}\nCommand exited with code 1` },
        ],
        isError: true,
      })).definition,
      { ...opts, unattended: () => false }
    );
    const c = await run(unavailable, { command: 'id -u', elevated: true });
    expect(c.details?.elevation).toBe('unavailable');
  });

  it('普通命令里 sudo 因无终端失败时，提示改用 elevated', async () => {
    const tool = withElevation(
      fakeBash(() => ({
        content: [
          {
            type: 'text',
            text: 'sudo: a terminal is required to read the password\nsudo: a password is required\n\nCommand exited with code 1',
          },
        ],
        isError: true,
      })).definition,
      { ...opts, unattended: () => false }
    );
    const result = await run(tool, { command: 'sudo id -u' });
    expect(result.content[0]?.text).toMatch(/elevated: true/);
  });
});
