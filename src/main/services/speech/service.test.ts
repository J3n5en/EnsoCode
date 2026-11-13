import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SpeechDownloadProgressDto, SpeechModelId } from '@shared/types/speech';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import type { SpeechEngine } from './engine';
import { HANBAO_ENGINE, hanbaoEngineDir, SPEECH_MODELS, speechModelDirName } from './model';
import { SHERPA_ONNX_VERSION, speechRuntimeDir } from './runtime';
import { joinSamples } from './segment';
import {
  __setSpeechTestHooks,
  cancelSpeechDownload,
  deleteSpeechModel,
  getSpeechStatus,
  onSpeechAvailabilityChange,
  openSpeechSession,
  prewarmSpeech,
  setSpeechCorrector,
  setSpeechProgressSink,
  speechAvailable,
  startSpeechDownload,
  syncSpeechFromSettings,
} from './service';

let root: string;
let loads: SpeechModelId[];
let disposed: SpeechModelId[];
let transcribed: number[];
let cancelled: number;

function installRuntime(): void {
  const runtime = speechRuntimeDir(path.join(root, 'runtime'), SHERPA_ONNX_VERSION);
  mkdirSync(path.join(runtime, 'sherpa-onnx-darwin-arm64'), { recursive: true });
  mkdirSync(path.join(runtime, 'sherpa-onnx-node'), { recursive: true });
  writeFileSync(path.join(runtime, 'sherpa-onnx-darwin-arm64', 'sherpa-onnx.node'), '');
  writeFileSync(path.join(runtime, 'sherpa-onnx-node', 'package.json'), '{}');
  writeFileSync(path.join(runtime, '.ready'), '');
}

function installModel(id: SpeechModelId): void {
  installRuntime();
  const dir = path.join(root, 'models', speechModelDirName(id));
  for (const file of SPEECH_MODELS[id].files) {
    mkdirSync(path.dirname(path.join(dir, file.name)), { recursive: true });
    writeFileSync(path.join(dir, file.name), 'x');
  }
  writeFileSync(path.join(dir, '.ready'), '{}');
}

/** 流式假引擎：每块回“已收到的块数”个字；整段假引擎：回带多余空格的一句 */
function fakeEngine(id: SpeechModelId): SpeechEngine {
  return {
    transcribe: async (samples) => {
      transcribed.push(samples.length);
      return ' 你好， 世界。 ';
    },
    openStream: () => {
      let text = '';
      return {
        accept: async () => {
          text += '字';
          return text;
        },
        finish: async () => `${text}。`,
        cancel: () => {
          cancelled++;
        },
      };
    },
    dispose: () => {
      disposed.push(id);
    },
  };
}

const second = () => new Float32Array(16_000);
const tone = (seconds: number) =>
  Float32Array.from({ length: seconds * 16_000 }, (_, i) => 0.3 * Math.sin(i / 10));
const quiet = (seconds: number) => new Float32Array(seconds * 16_000);
const concat = (...parts: Float32Array[]) => joinSamples(parts);
const enable = (extra: Record<string, unknown> = {}) =>
  syncSpeechFromSettings({ voiceInputEnabled: true, voiceModel: 'x-asr-streaming', ...extra });

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'enso-speech-'));
  loads = [];
  disposed = [];
  transcribed = [];
  cancelled = 0;
  __setSpeechTestHooks({
    root,
    platform: 'darwin',
    arch: 'arm64',
    createEngine: async (spec) => {
      loads.push(spec.id);
      return fakeEngine(spec.id);
    },
  });
  syncSpeechFromSettings({});
});

afterEach(() => {
  __setSpeechTestHooks(null);
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('speech sessions', () => {
  it('refuses to record while voice input is switched off', async () => {
    installModel('x-asr-streaming');
    const session = openSpeechSession(() => {});
    session.push(second());
    await expect(session.finish()).resolves.toEqual({ ok: false, error: 'disabled' });
    expect(loads).toEqual([]);
  });

  it('reports a missing model instead of loading an engine that is not on disk', async () => {
    enable();
    expect(getSpeechStatus().state).toBe('missing');
    await expect(openSpeechSession(() => {}).finish()).resolves.toEqual({
      ok: false,
      error: 'not-ready',
    });
  });

  it('streams partial text while recording and returns the final text', async () => {
    installModel('x-asr-streaming');
    enable();
    const partials: string[] = [];
    const session = openSpeechSession((text) => partials.push(text));
    session.push(second());
    session.push(second());
    await expect(session.finish()).resolves.toEqual({ ok: true, text: '字字。' });
    expect(partials).toEqual(['字', '字字']);
  });

  it('buffers audio for a whole-utterance model and normalizes its output', async () => {
    installModel('x-asr');
    enable({ voiceModel: 'x-asr' });
    const partials: string[] = [];
    for (let i = 0; i < 2; i++) {
      const session = openSpeechSession((text) => partials.push(text));
      session.push(second());
      session.push(second());
      await expect(session.finish()).resolves.toEqual({ ok: true, text: '你好，世界。' });
    }
    expect(transcribed).toEqual([32_000, 32_000]);
    expect(loads).toEqual(['x-asr']);
    expect(partials).toEqual([]);
  });

  it('recognizes a local whole-utterance model sentence by sentence while recording', async () => {
    installModel('qwen3-asr');
    enable({ voiceModel: 'qwen3-asr' });
    const partials: string[] = [];
    const session = openSpeechSession((text) => partials.push(text));
    session.push(concat(quiet(0.3), tone(1), quiet(1.2)));
    await vi.waitFor(() => expect(partials).toEqual(['你好，世界。']));
    session.push(concat(tone(1), quiet(0.3)));
    await expect(session.finish()).resolves.toEqual({
      ok: true,
      text: '你好，世界。你好，世界。',
    });
    expect(transcribed).toHaveLength(2);
    expect(transcribed[0] + transcribed[1]).toBe(16_000 * 3.8);
    expect(partials).toEqual(['你好，世界。']);
  });

  it('rejects empty recordings and recordings longer than the cap', async () => {
    installModel('x-asr-streaming');
    enable();
    await expect(openSpeechSession(() => {}).finish()).resolves.toEqual({
      ok: false,
      error: 'invalid-audio',
    });
    const long = openSpeechSession(() => {});
    for (let i = 0; i < 301; i++) long.push(second());
    await expect(long.finish()).resolves.toEqual({ ok: false, error: 'invalid-audio' });
  });

  it('cancels the engine stream and ignores audio pushed after cancel', async () => {
    installModel('x-asr-streaming');
    enable();
    const partials: string[] = [];
    const session = openSpeechSession((text) => partials.push(text));
    session.cancel();
    session.push(second());
    await expect(session.finish()).resolves.toEqual({ ok: false, error: 'failed' });
    await vi.waitFor(() => expect(cancelled).toBe(1));
    expect(partials).toEqual([]);
  });

  it('swaps the engine when the selected model changes', async () => {
    installModel('x-asr-streaming');
    installModel('sense-voice');
    enable();
    const first = openSpeechSession(() => {});
    first.push(second());
    await first.finish();
    enable({ voiceModel: 'sense-voice' });
    const next = openSpeechSession(() => {});
    next.push(second());
    await expect(next.finish()).resolves.toMatchObject({ ok: true });
    expect(loads).toEqual(['x-asr-streaming', 'sense-voice']);
    expect(disposed).toEqual(['x-asr-streaming']);
  });

  it('drops the engine after ten idle minutes but not while a session is open', async () => {
    vi.useFakeTimers();
    installModel('x-asr-streaming');
    enable();
    const open = openSpeechSession(() => {});
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(disposed).toEqual([]);
    open.push(second());
    await open.finish();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(disposed).toEqual(['x-asr-streaming']);
    const again = openSpeechSession(() => {});
    again.push(second());
    await again.finish();
    expect(loads).toEqual(['x-asr-streaming', 'x-asr-streaming']);
  });
});

describe('speech correction', () => {
  const record = async (partials: [string, boolean][] = []) => {
    const session = openSpeechSession((text, correcting) => partials.push([text, correcting]));
    session.push(second());
    return session.finish();
  };

  beforeEach(() => {
    installModel('x-asr');
  });

  it('shows the raw text as being corrected and returns the corrected text', async () => {
    enable({ voiceModel: 'x-asr', voiceCorrectionEnabled: true });
    setSpeechCorrector(async (text) => text.replace('世界', '世界！'));
    const partials: [string, boolean][] = [];
    await expect(record(partials)).resolves.toEqual({ ok: true, text: '你好，世界！。' });
    expect(partials).toEqual([['你好，世界。', true]]);
  });

  it('announces the correction even when the streamed text is already final', async () => {
    installModel('x-asr-streaming');
    __setSpeechTestHooks({
      root,
      platform: 'darwin',
      arch: 'arm64',
      createEngine: async () => ({
        ...fakeEngine('x-asr-streaming'),
        openStream: () => ({
          accept: async () => '你好。',
          finish: async () => '你好。',
          cancel: () => {},
        }),
      }),
    });
    enable({ voiceCorrectionEnabled: true });
    setSpeechCorrector(async (text) => text);
    const partials: [string, boolean][] = [];
    await expect(record(partials)).resolves.toEqual({ ok: true, text: '你好。' });
    expect(partials).toEqual([
      ['你好。', false],
      ['你好。', true],
    ]);
  });

  it('skips correction when it is switched off', async () => {
    enable({ voiceModel: 'x-asr' });
    const corrector = vi.fn(async () => 'changed');
    setSpeechCorrector(corrector);
    await expect(record()).resolves.toEqual({ ok: true, text: '你好，世界。' });
    expect(corrector).not.toHaveBeenCalled();
  });

  it('keeps the transcript when the corrector fails, is unavailable or answers instead', async () => {
    enable({ voiceModel: 'x-asr', voiceCorrectionEnabled: true });
    const raw = { ok: true, text: '你好，世界。' };
    setSpeechCorrector(async () => {
      throw new Error('boom');
    });
    await expect(record()).resolves.toEqual(raw);
    setSpeechCorrector(async () => null);
    await expect(record()).resolves.toEqual(raw);
    setSpeechCorrector(async () => `好的，下面是回答：${'很长的内容'.repeat(10)}`);
    await expect(record()).resolves.toEqual(raw);
  });

  it('gives up on a correction that takes too long', async () => {
    vi.useFakeTimers();
    enable({ voiceModel: 'x-asr', voiceCorrectionEnabled: true });
    setSpeechCorrector(() => new Promise(() => {}));
    const result = record();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(result).resolves.toEqual({ ok: true, text: '你好，世界。' });
  });
});

describe('speech status', () => {
  it('lists every model with its streaming flag and download state', () => {
    installModel('x-asr');
    enable({ voiceModel: 'x-asr' });
    const status = getSpeechStatus();
    expect(status.selected).toBe('x-asr');
    expect(status.state).toBe('ready');
    expect(status.models.map((m) => [m.id, m.streaming, m.state])).toEqual([
      ['x-asr-streaming', true, 'missing'],
      ['x-asr', false, 'ready'],
      ['qwen3-asr', false, 'missing'],
      ['sense-voice', false, 'missing'],
      ['hanbao', true, 'missing'],
      ['gemini-live', true, 'missing'],
      ['wetype', true, 'ready'],
    ]);
  });

  it('offers the WeType cloud model without credentials or downloads', async () => {
    syncSpeechFromSettings({ voiceInputEnabled: true, voiceModel: 'wetype' });
    expect(getSpeechStatus().state).toBe('ready');
    expect(speechAvailable()).toBe(true);
    await expect(startSpeechDownload('wetype')).resolves.toBe(false);
    await expect(deleteSpeechModel('wetype')).resolves.toBe(false);
  });

  it('prewarms only a ready cloud engine', async () => {
    let prewarmed = 0;
    __setSpeechTestHooks({
      root,
      platform: 'darwin',
      arch: 'arm64',
      createEngine: async (spec) => {
        loads.push(spec.id);
        return { ...fakeEngine(spec.id), prewarm: () => prewarmed++ };
      },
    });
    installModel('x-asr-streaming');
    syncSpeechFromSettings({ voiceInputEnabled: true, voiceModel: 'x-asr-streaming' });
    prewarmSpeech();
    syncSpeechFromSettings({ voiceInputEnabled: false, voiceModel: 'wetype' });
    prewarmSpeech();
    await Promise.resolve();
    expect(loads).toEqual([]);
    syncSpeechFromSettings({ voiceInputEnabled: true, voiceModel: 'wetype' });
    prewarmSpeech();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loads).toEqual(['wetype']);
    expect(prewarmed).toBe(1);
  });

  describe('Gemini cloud model', () => {
    const gemini = {
      voiceInputEnabled: true,
      voiceModel: 'gemini-live',
      voiceGeminiApiKey: 'AIza',
    };

    it('is ready once the voice settings hold a Gemini key, with no download or local engine runtime', async () => {
      syncSpeechFromSettings(gemini);
      expect(getSpeechStatus().state).toBe('ready');
      expect(getSpeechStatus().models.find((m) => m.id === 'gemini-live')?.remote).toBe(true);
      expect(speechAvailable()).toBe(true);
      await expect(startSpeechDownload('gemini-live')).resolves.toBe(false);
      const session = openSpeechSession(() => {});
      session.push(second());
      await expect(session.finish()).resolves.toEqual({ ok: true, text: '字。' });
    });

    it('stays usable on platforms without the local engine', () => {
      __setSpeechTestHooks({
        root,
        platform: 'freebsd',
        arch: 'riscv',
        createEngine: async () => fakeEngine('gemini-live'),
      });
      syncSpeechFromSettings(gemini);
      expect(getSpeechStatus().state).toBe('ready');
    });

    it('is not ready without a Gemini key', async () => {
      syncSpeechFromSettings({ ...gemini, voiceGeminiApiKey: '' });
      expect(getSpeechStatus().state).toBe('missing');
      expect(speechAvailable()).toBe(false);
      await expect(openSpeechSession(() => {}).finish()).resolves.toEqual({
        ok: false,
        error: 'not-ready',
      });
    });
  });

  describe('hanbao engine downloaded on demand', () => {
    const hanbao = { voiceInputEnabled: true, voiceModel: 'hanbao' };
    const engineDir = () => hanbaoEngineDir(path.join(root, 'runtime'));
    const installHanbaoModel = () => {
      const dir = path.join(root, 'models', speechModelDirName('hanbao'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'model.flute'), 'x');
      writeFileSync(path.join(dir, '.ready'), '{}');
    };
    const installEngine = () => {
      for (const file of HANBAO_ENGINE.files) {
        mkdirSync(path.dirname(path.join(engineDir(), file.name)), { recursive: true });
        writeFileSync(path.join(engineDir(), file.name), 'x');
      }
      writeFileSync(path.join(engineDir(), '.ready'), '{}');
    };
    const onPlatform = (platform: string, arch: string) =>
      __setSpeechTestHooks({
        root,
        platform,
        arch,
        createEngine: async (spec) => {
          loads.push(spec.id);
          return fakeEngine(spec.id);
        },
      });

    it('is hidden and not downloadable off Apple silicon', async () => {
      onPlatform('darwin', 'x64');
      installEngine();
      installHanbaoModel();
      syncSpeechFromSettings(hanbao);
      const status = getSpeechStatus();
      expect(status.models.map((m) => m.id)).not.toContain('hanbao');
      expect(status.state).toBe('missing');
      expect(speechAvailable()).toBe(false);
      await expect(startSpeechDownload('hanbao')).resolves.toBe(false);
    });

    it('is not ready until its engine is installed too', () => {
      installHanbaoModel();
      syncSpeechFromSettings(hanbao);
      expect(getSpeechStatus().models.find((m) => m.id === 'hanbao')?.state).toBe('missing');
      installEngine();
      expect(getSpeechStatus().state).toBe('ready');
    });

    it('fetches its engine first and never the sherpa runtime', async () => {
      const urls: string[] = [];
      vi.stubGlobal('fetch', async (url: string) => {
        urls.push(String(url));
        cancelSpeechDownload('hanbao');
        return new Response('no', { status: 500 });
      });
      try {
        await expect(startSpeechDownload('hanbao')).resolves.toBe(false);
      } finally {
        vi.unstubAllGlobals();
      }
      expect(urls).toEqual([HANBAO_ENGINE.archive?.url]);
    });

    it('streams partial text with its own engine and no sherpa runtime', async () => {
      installEngine();
      installHanbaoModel();
      syncSpeechFromSettings(hanbao);
      expect(getSpeechStatus().state).toBe('ready');
      const partials: string[] = [];
      const session = openSpeechSession((text) => partials.push(text));
      session.push(second());
      session.push(second());
      await expect(session.finish()).resolves.toEqual({ ok: true, text: '字字。' });
      expect(partials).toEqual(['字', '字字']);
      expect(loads).toEqual(['hanbao']);
    });

    it('removes its engine together with the model', async () => {
      installEngine();
      installHanbaoModel();
      await expect(deleteSpeechModel('hanbao')).resolves.toBe(true);
      expect(existsSync(engineDir())).toBe(false);
    });
  });

  it('tells listeners when voice input becomes usable or stops being usable', async () => {
    installModel('x-asr-streaming');
    const seen: boolean[] = [];
    const off = onSpeechAvailabilityChange((available) => seen.push(available));
    enable();
    enable();
    expect(speechAvailable()).toBe(true);
    await deleteSpeechModel('x-asr-streaming');
    expect(speechAvailable()).toBe(false);
    expect(getSpeechStatus().state).toBe('missing');
    off();
    expect(seen).toEqual([true, false]);
  });

  // 共用的运行时安装曾绑定第一个下载的取消信号：取消 A 会把同时在等运行时的 B 一起弄失败
  it('两个模型共用运行时安装时，取消其中一个不会让另一个失败', async () => {
    // 慢速网络：请求只在被 abort 时结束
    const installSignals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal) installSignals.push(init.signal);
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        })
    );
    const events: SpeechDownloadProgressDto[] = [];
    setSpeechProgressSink((progress) => events.push(progress));
    try {
      const first = startSpeechDownload('x-asr-streaming');
      const second = startSpeechDownload('x-asr');
      cancelSpeechDownload('x-asr-streaming');
      await expect(first).resolves.toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events.filter((event) => event.modelId === 'x-asr' && event.done)).toEqual([]);
      expect(getSpeechStatus().models.find((model) => model.id === 'x-asr')?.state).toBe(
        'downloading'
      );
      expect(installSignals.some((signal) => signal.aborted)).toBe(false);
      // 等待者全部取消后才真正中止安装
      cancelSpeechDownload('x-asr');
      await expect(second).resolves.toBe(false);
      expect(installSignals.length).toBeGreaterThan(0);
      expect(installSignals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      setSpeechProgressSink(null);
      vi.unstubAllGlobals();
    }
  });

  it('announces a deletion so other windows re-read the status', async () => {
    installModel('x-asr');
    const events: SpeechDownloadProgressDto[] = [];
    setSpeechProgressSink((progress) => events.push(progress));
    await deleteSpeechModel('x-asr');
    setSpeechProgressSink(null);
    expect(events).toEqual([expect.objectContaining({ modelId: 'x-asr', done: true })]);
    expect(events[0].error).toBeUndefined();
  });
});
