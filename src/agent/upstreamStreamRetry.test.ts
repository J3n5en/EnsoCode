import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type AssistantMessage, isRetryableAssistantError } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

const error = (errorMessage: string) => ({ stopReason: 'error', errorMessage }) as AssistantMessage;

const UPSTREAM =
  'The upstream stream ended before the response was complete. (request id: 20261105051007113059483c1sSXqTh)';
const AGENT_RETRY_BUNDLE = fileURLToPath(
  new URL(
    '../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-62VOPMLK.js',
    import.meta.url
  )
);

describe('upstream stream cutoff', () => {
  it('网关在回复完成前掐断流时，按可重试错误处理', () => {
    expect(isRetryableAssistantError(error(UPSTREAM))).toBe(true);
  });

  it('打包后的 agent 使用同一条规则', () => {
    const agentBundle = readFileSync(AGENT_RETRY_BUNDLE, 'utf8');
    expect(agentBundle).toContain('upstream stream ended before the response was complete');
  });
});
