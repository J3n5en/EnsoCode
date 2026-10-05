import { afterEach, expect, it, vi } from 'vitest';
import type { AgentWorkerEvent } from '../../../shared/types/agent';
import type { BotRoutine } from '../../../shared/types/bot';
import type { BotSessionHost, BotTurnFinished } from './botSessionHost';
import type { BotChatStore } from './chatStore';
import type { GroupChatService } from './groupChat';
import { RoutineRunner } from './routineRunner';

afterEach(() => vi.useRealTimers());
const ROUTINE: BotRoutine = {
  id: 'r',
  botId: 'b',
  chatId: 'c',
  title: 'run "x"',
  prompt: 'work',
  schedule: '* * * * *',
  status: 'enabled',
  procedureVersion: 1,
  approvedVersion: 1,
  catchUp: true,
  createdAt: 0,
  updatedAt: 0,
};
const OPTIONS = { deliveryId: 'routine:r:60000', executorId: 'b', dryRun: false };
it('dispose cancels pending routines and clears approval timers', async () => {
  vi.useFakeTimers();
  let deliveryId: string | undefined;
  const deny = vi.fn();
  const runner = new RoutineRunner({
    host: {
      onTurnFinished: () => () => {},
      activeDeliveryId: () => deliveryId,
      deliver: async (
        _chat: string,
        _bot: string,
        _text: string,
        options: { deliveryId: string }
      ) => {
        deliveryId = options.deliveryId;
        return { ok: true, conversationId: 's', queued: true };
      },
    } as unknown as BotSessionHost,
    chats: { get: () => ({ kind: 'direct' }) } as unknown as BotChatStore,
    groups: {} as GroupChatService,
    deny,
  });
  const pending = runner.run(ROUTINE, OPTIONS);
  runner.observe({
    type: 'approval-request',
    identity: { sessionId: 's', generation: 'g' },
    seq: 1,
    request: { requestId: 'req' },
  } as AgentWorkerEvent);
  runner.dispose();
  expect(await pending).toEqual({ ok: false, error: 'canceled' });
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
  expect(deny).not.toHaveBeenCalled();
});
it('denies unanswered approvals after 30 minutes only for the routine delivery and exact identity', async () => {
  vi.useFakeTimers();
  let deliveryId: string | undefined;
  let finish!: (event: BotTurnFinished) => void;
  const deny = vi.fn();
  const runner = new RoutineRunner({
    host: {
      onTurnFinished: (listener: typeof finish) => {
        finish = listener;
        return () => {};
      },
      activeDeliveryId: () => deliveryId,
      deliver: async (
        _chat: string,
        _bot: string,
        _text: string,
        options: { deliveryId: string }
      ) => {
        deliveryId = options.deliveryId;
        return { ok: true, conversationId: 's' };
      },
    } as unknown as BotSessionHost,
    chats: { get: () => ({ kind: 'direct' }) } as unknown as BotChatStore,
    groups: {} as GroupChatService,
    deny,
  });
  const identity = { sessionId: 's', generation: 'g' };
  const approval = {
    type: 'approval-request',
    identity,
    seq: 1,
    request: { requestId: 'req' },
  } as AgentWorkerEvent;
  runner.observe(approval);
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
  expect(deny).not.toHaveBeenCalled();
  const running = runner.run(ROUTINE, OPTIONS);
  runner.observe(approval);
  finish({
    botId: 'b',
    chatId: 'c',
    conversationId: 's',
    text: '',
    ok: false,
    error: 'canceled',
    deliveryId: 'other-queued-routine',
  });
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
  expect(deny).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(deny).toHaveBeenCalledWith(identity, 'req');
  finish({ botId: 'b', chatId: 'c', conversationId: 's', text: '', ok: true, deliveryId });
  expect(await running).toEqual({ ok: true, conversationId: 's' });
});

it('以执行成员身份、用派生的 deliveryId 投递；试运行在提示和群系统条目里注明', async () => {
  const deliver = vi.fn(async () => ({
    ok: true as const,
    conversationId: 's',
    duplicate: true as const,
  }));
  const runAs = vi.fn(async () => ({ ok: false as const, error: 'group-busy' }));
  const chats = { kind: 'direct' };
  const runner = new RoutineRunner({
    host: {
      onTurnFinished: () => () => {},
      activeDeliveryId: () => undefined,
      deliver,
    } as unknown as BotSessionHost,
    chats: { get: () => chats } as unknown as BotChatStore,
    groups: { runAs } as unknown as GroupChatService,
    deny: vi.fn(),
  });
  expect(await runner.run(ROUTINE, { ...OPTIONS, executorId: 'e' })).toEqual({
    ok: false,
    error: 'duplicate',
    conversationId: 's',
  });
  expect(deliver).toHaveBeenCalledWith(
    'c',
    'e',
    '<routine title="run &quot;x&quot;">work</routine>',
    { deliveryId: OPTIONS.deliveryId, queueIfBusy: true, source: 'background' }
  );
  chats.kind = 'group';
  expect(await runner.run(ROUTINE, { ...OPTIONS, dryRun: true })).toEqual({
    ok: false,
    error: 'group-busy',
  });
  const [chatId, botId, text, title] = runAs.mock.calls[0] as unknown as string[];
  expect([chatId, botId, title]).toEqual(['c', 'b', 'run "x"（试运行）']);
  expect(text).toMatch(/^<routine title="run &quot;x&quot;" dry-run="true">\[Dry run\]/);
  expect(text).toMatch(/work<\/routine>$/);
  runner.dispose();
});
