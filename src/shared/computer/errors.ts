/** 同一调用能否重试：safe=原样重试；later=稍等再试；reobserve=先重新 ax()/find()/screenshot()；never=不要重试，改参数或问用户 */
export type ComputerRetry = 'safe' | 'later' | 'reobserve' | 'never';

const RETRY_BY_CODE: Record<string, ComputerRetry> = {
  'stale-ref': 'reobserve',
  'window-not-found': 'reobserve',
  frame: 'reobserve',
  'ax-worker-exited': 'safe',
  'lease-busy': 'later',
  'user-active': 'later',
  'focus-steal': 'later',
  'lease-deadlock': 'never',
  'app-denied': 'never',
  'app-prompt-dismissed': 'never',
  'app-unknown': 'never',
  unsupported: 'never',
  permission: 'never',
  'read-only': 'never',
  'background-unavailable': 'never',
};

export function computerErrorRetry(code: string): ComputerRetry | undefined {
  return RETRY_BY_CODE[code];
}

export class ComputerError extends Error {
  readonly code: string;
  readonly retry: ComputerRetry | undefined;
  constructor(code: string, message: string, retry?: ComputerRetry) {
    super(message);
    this.name = 'ComputerError';
    this.code = code;
    this.retry = retry ?? computerErrorRetry(code);
  }
}

export class StaleRefError extends ComputerError {
  constructor(reference: string, detail = 'expired') {
    super('stale-ref', `${reference} ${detail}; re-run ax()/find()`);
    this.name = 'StaleRef';
  }
}

export class BackgroundUnavailableError extends ComputerError {
  constructor(detail: string) {
    super(
      'background-unavailable',
      `${detail}; retry with delivery:"foreground" or use AX actions`
    );
    this.name = 'BackgroundUnavailable';
  }
}

export class PermissionError extends ComputerError {
  constructor(
    readonly permission: 'capture' | 'input' | 'ax',
    message: string
  ) {
    super('permission', message);
    this.name = 'PermissionError';
  }
}

export class ReadOnlyError extends ComputerError {
  constructor(method: string) {
    super('read-only', `read-only run: '${method}' requires read_only: false`);
    this.name = 'ReadOnlyError';
  }
}

export class FrameError extends ComputerError {
  constructor(message: string) {
    super('frame', message);
    this.name = 'FrameError';
  }
}
