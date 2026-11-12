import { existsSync } from 'node:fs';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  buildElevatedCommand,
  ELEVATE_ASKPASS_ENV,
  ELEVATE_DECLINED_MARKER,
  ELEVATE_TIMED_OUT_MARKER,
  ELEVATE_TIMEOUT_MS,
  ELEVATE_UNAVAILABLE_MARKER,
  type ElevatedCommandOptions,
} from '@shared/elevation';

/**
 * bash 提权：`elevated: true` 时经 `sudo -k -A` 执行，SUDO_ASKPASS 指向 Main 写出的 helper。
 * 口令只走「Enso 口令窗口 / 完整模式 → Main → helper stdout → sudo」，不经过 worker、模型或日志；
 * `-k` 加上每条命令独立会话，使一次授权只覆盖这一条命令。
 * 界面显示的是 Main 从 sudo 进程真实 argv 还原的命令，模型无法伪造展示内容。
 */

/** Main 提供了 askpass helper 且本机有 sudo 时可用 */
export function prepareElevation(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform
): ElevatedCommandOptions | null {
  const askpassPath = env[ELEVATE_ASKPASS_ENV];
  if (platform === 'win32' || !askpassPath) return null;
  const sudoPath = ['/usr/bin/sudo', '/bin/sudo'].find(exists);
  return sudoPath && exists(askpassPath) ? { sudoPath, askpassPath } : null;
}

const SUDO_PREFIX = /^\s*(?:\S*\/)?sudo(?:\s|$)/;
const SUDO_NO_TTY = /sudo: (?:a terminal is required|a password is required|no tty present)/i;

type ToolResult = {
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
};

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function refusal(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], details, isError: true };
}

export function withElevation(
  definition: ToolDefinition,
  options: ElevatedCommandOptions & { unattended: () => boolean }
): ToolDefinition {
  const name = definition.name;
  const base = definition.parameters as unknown as {
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  const parameters = {
    ...base,
    properties: {
      ...base.properties,
      elevated: {
        type: 'boolean',
        description:
          'Run this command as root through sudo. The user approves each command by typing their ' +
          'password in an EnsoCode dialog; one approval never covers another command. Use only when ' +
          'the command truly needs root (system packages, files the user cannot write, system ' +
          'services). Do not prefix the command with sudo, keep it to the part that needs root, and ' +
          "say in your reply what it will change. Root runs with sudo's reset environment.",
      },
    },
  } as ToolDefinition['parameters'];
  return {
    ...definition,
    parameters,
    promptGuidelines: [
      ...(definition.promptGuidelines ?? []),
      `When a ${name} command needs root, set elevated: true instead of writing sudo; if the user declines the password dialog, do not retry unless they ask.`,
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { elevated, ...rest } = params as Record<string, unknown>;
      if (elevated !== true || typeof rest.command !== 'string') {
        const result = (await definition.execute(
          toolCallId,
          rest as never,
          signal,
          onUpdate,
          ctx
        )) as ToolResult;
        if (result.isError !== true || !SUDO_NO_TTY.test(textOf(result))) return result as never;
        const hint =
          'sudo cannot ask for a password in this shell. If the command really needs root, run it again without sudo and with elevated: true.';
        const content = [...(result.content ?? [])];
        const last = content.findLastIndex((part) => part?.type === 'text');
        if (last >= 0)
          content[last] = { ...content[last], text: `${content[last]?.text}\n\n${hint}` };
        else content.push({ type: 'text', text: hint });
        return { ...result, content } as never;
      }
      if (options.unattended()) {
        return refusal(
          'This run is unattended, so nobody can approve the administrator password dialog. The command did not run; report what needs root instead.'
        );
      }
      if (SUDO_PREFIX.test(rest.command)) {
        return refusal(
          'Do not prefix the command with sudo when elevated is true: the tool runs it through sudo itself. The command did not run; call again without sudo.'
        );
      }
      const result = (await definition.execute(
        toolCallId,
        { ...rest, command: buildElevatedCommand(rest.command, options) } as never,
        signal,
        onUpdate,
        ctx
      )) as ToolResult;
      const text = textOf(result);
      const details =
        result.details && typeof result.details === 'object'
          ? (result.details as Record<string, unknown>)
          : {};
      if (text.includes(ELEVATE_DECLINED_MARKER)) {
        return refusal(
          'The user declined the administrator password dialog, so the command did not run. Do not retry it unless the user asks.',
          { ...details, elevation: 'declined' }
        );
      }
      if (text.includes(ELEVATE_TIMED_OUT_MARKER)) {
        return refusal(
          `Nobody answered the administrator password dialog within ${ELEVATE_TIMEOUT_MS / 60_000} minutes, so the command did not run. Ask the user before trying again.`,
          { ...details, elevation: 'timed_out' }
        );
      }
      if (text.includes(ELEVATE_UNAVAILABLE_MARKER)) {
        return refusal(
          'No EnsoCode window that can take the administrator password is open (desktop app or phone in full mode), so the command did not run. Tell the user what needs root instead.',
          { ...details, elevation: 'unavailable' }
        );
      }
      return result as never;
    },
  };
}
