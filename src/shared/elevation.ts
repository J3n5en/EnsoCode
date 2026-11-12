import { shellQuote } from './ssh';

/**
 * bash 提权的跨层约定：worker 拼 sudo 命令，Main 的 askpass 服务按同一格式从 sudo argv 还原命令给用户看。
 * 口令只在「用户界面 → Main → askpass helper → sudo」之间流动，永远不进 worker、模型或日志。
 */

export const ELEVATE_DECLINED_MARKER = 'ENSO_ELEVATE_DECLINED';
export const ELEVATE_TIMED_OUT_MARKER = 'ENSO_ELEVATE_TIMED_OUT';
export const ELEVATE_UNAVAILABLE_MARKER = 'ENSO_ELEVATE_UNAVAILABLE';
export const ELEVATE_TIMEOUT_MS = 120_000;
/** Main 把 askpass helper 路径经此环境变量交给 worker */
export const ELEVATE_ASKPASS_ENV = 'ENSO_ELEVATE_ASKPASS';

export interface ElevatedCommandOptions {
  sudoPath: string;
  askpassPath: string;
}

export function buildElevatedCommand(command: string, options: ElevatedCommandOptions): string {
  return `SUDO_ASKPASS=${shellQuote(options.askpassPath)} ${shellQuote(options.sudoPath)} -k -A -- /bin/bash -c ${shellQuote(command)}`;
}

const SUDO_ARGS = /^\S*sudo -k -A -- \/bin\/bash -c /;

/** 从 `ps -o args=` 的 sudo argv 还原被提权的命令；不是 Enso 拼出的格式返回 null */
export function elevatedCommandOf(sudoArgs: string): string | null {
  const match = SUDO_ARGS.exec(sudoArgs);
  return match ? sudoArgs.slice(match[0].length) : null;
}

/** 给界面看的待批请求（不含任何口令） */
export interface ElevationRequestView {
  id: string;
  command: string;
  /** 同一条 sudo 已经收到过口令又来要：上次口令不对 */
  retry: boolean;
  expiresAt: number;
}

export type ElevationOutcome =
  | { kind: 'password'; password: string }
  | { kind: 'declined' | 'timeout' | 'unavailable' };
