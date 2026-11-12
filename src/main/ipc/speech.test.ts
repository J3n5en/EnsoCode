import { decodeRemoteValue, encodeRemoteValue } from '@enso/pair';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  pushed: [] as Float32Array[],
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
      mocks.listeners.set(channel, listener);
    }),
  },
}));
vi.mock('../services/renderers', () => ({
  broadcastToRenderers: vi.fn(),
  isMainRenderer: (id: number) => id === 1,
  isSettingsRenderer: () => false,
}));
vi.mock('../services/speech/service', () => ({
  cancelSpeechDownload: vi.fn(),
  deleteSpeechModel: vi.fn(),
  getSpeechStatus: vi.fn(),
  onSpeechAvailabilityChange: vi.fn(),
  // 与真实会话同口径：一块都没收到就是 invalid-audio
  openSpeechSession: vi.fn(() => ({
    push: (samples: Float32Array) => mocks.pushed.push(samples),
    finish: async () =>
      mocks.pushed.length > 0 ? { ok: true, text: '你好' } : { ok: false, error: 'invalid-audio' },
    cancel: vi.fn(),
  })),
  prewarmSpeech: vi.fn(),
  setSpeechProgressSink: vi.fn(),
  startSpeechDownload: vi.fn(),
}));

import { IPC_CHANNELS } from '@shared/types';
import { registerSpeechHandlers } from './speech';

const PCM = [0.25, -0.5, 1, 0, -1, 0.125];
const sender = { id: 1, once: vi.fn(), isDestroyed: () => false, send: vi.fn() };

/** 远端浏览器的 send：经配对通道 JSON 编解码后宿主拿到的参数 */
function overRemoteTunnel(args: unknown[]): unknown[] {
  return decodeRemoteValue(JSON.parse(JSON.stringify(encodeRemoteValue(args))));
}

const push = (sessionId: string, audio: unknown) =>
  mocks.listeners.get(IPC_CHANNELS.SPEECH_SESSION_PUSH)?.({ sender }, sessionId, audio);

const finish = (sessionId: string) =>
  Promise.resolve(mocks.handlers.get(IPC_CHANNELS.SPEECH_SESSION_FINISH)?.({ sender }, sessionId));

describe('语音会话推流', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.listeners.clear();
    mocks.pushed.length = 0;
    registerSpeechHandlers();
  });

  // 背景：远端编码把 Float32Array 变成字节（remote.ts 的 u8），宿主收到 Uint8Array 后被静默丢弃，结束恒为 invalid-audio
  it('远端浏览器推来的音频（经配对通道编码成字节）照常送进识别会话', async () => {
    const [sessionId, audio] = overRemoteTunnel(['voice-remote', new Float32Array(PCM)]);
    expect(audio).toBeInstanceOf(Uint8Array);

    push(sessionId as string, audio);

    expect(mocks.pushed.map((samples) => [...samples])).toEqual([PCM]);
    await expect(finish(sessionId as string)).resolves.toEqual({ ok: true, text: '你好' });
  });

  it('字节视图起点没按 4 对齐时照样还原成同一段 PCM', () => {
    const bytes = new Uint8Array(new Float32Array(PCM).buffer);
    const shifted = new Uint8Array(bytes.byteLength + 1);
    shifted.set(bytes, 1);

    push('voice-shifted', shifted.subarray(1));

    expect(mocks.pushed.map((samples) => [...samples])).toEqual([PCM]);
  });

  it('字节数不是 4 的倍数的坏数据直接丢弃，不开会话也不抛错', async () => {
    expect(() => push('voice-bad', new Uint8Array([1, 2, 3, 4, 5]))).not.toThrow();

    expect(mocks.pushed).toHaveLength(0);
    await expect(finish('voice-bad')).resolves.toEqual({ ok: false, error: 'invalid-audio' });
  });
});
