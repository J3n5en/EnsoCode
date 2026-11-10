import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type AssistantMessage, isRetryableAssistantError } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

const error = (errorMessage: string) => ({ stopReason: 'error', errorMessage }) as AssistantMessage;

const UPSTREAM =
  'The upstream stream ended before the response was complete. (request id: 20261105051007113059483c1sSXqTh)';
const AGENT_BUNDLE_CHUNKS = fileURLToPath(
  new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/', import.meta.url)
);

describe('upstream stream cutoff', () => {
  it('网关在回复完成前掐断流时，按可重试错误处理', () => {
    expect(isRetryableAssistantError(error(UPSTREAM))).toBe(true);
  });

  it('打包后的 agent 使用同一条规则', () => {
    const agentBundle = readdirSync(AGENT_BUNDLE_CHUNKS)
      .filter((name) => name.endsWith('.js'))
      .map((name) => readFileSync(`${AGENT_BUNDLE_CHUNKS}${name}`, 'utf8'))
      .find((source) => source.includes('RETRYABLE_PROVIDER_ERROR_PATTERN'));
    expect(agentBundle).toContain('upstream stream ended before the response was complete');
  });
});
