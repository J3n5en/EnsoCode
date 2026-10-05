import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type AgentWorkerEvent, parseAgentCommand } from '@shared/types/agent';
import { describe, expect, it } from 'vitest';
import type { OauthPoolSelector } from './oauthAccountPool';
import { SessionSupervisor } from './supervisor';

describe('supervisor选号回执', () => {
  it('production selector按requestId返回各自opaque receipt，并保留failure和活动排除', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'enso-selector-'));
    const events: AgentWorkerEvent[] = [];
    const supervisor = new SessionSupervisor({
      agentDir: root,
      sessionDir: root,
      emit: (event) => events.push(event),
    });
    try {
      const select = Reflect.get(supervisor, 'selectOauthPool') as OauthPoolSelector;
      const receipts = [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ];
      const failed = {
        accountKey: 'openai-codex',
        reason: 'login-invalid' as const,
        selectionReceipt: receipts[0],
      };
      const first = select('pool', 'm');
      const second = select('pool', 'm', failed, undefined, ['openai-codex']);
      const requests = events.filter((event) => event.type === 'oauth-pool-select');
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({ failed, excludedAccountKeys: ['openai-codex'] });
      for (const index of [1, 0]) {
        const command = parseAgentCommand({
          type: 'oauth-pool-result',
          requestId: requests[index].requestId,
          accountKey: 'openai-codex#2',
          selectionReceipt: receipts[index],
        });
        expect(command).not.toBeNull();
        supervisor.handleCommand(command!);
      }
      await expect(first).resolves.toEqual({
        accountKey: 'openai-codex#2',
        selectionReceipt: receipts[0],
      });
      await expect(second).resolves.toEqual({
        accountKey: 'openai-codex#2',
        selectionReceipt: receipts[1],
      });
      const legacy = select('pool', 'm');
      const request = events.at(-1);
      if (request?.type !== 'oauth-pool-select') throw new Error('missing selection event');
      supervisor.handleCommand({
        type: 'oauth-pool-result',
        requestId: request.requestId,
        accountKey: 'openai-codex',
      });
      await expect(legacy).resolves.toEqual({ accountKey: 'openai-codex' });
    } finally {
      await supervisor.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
