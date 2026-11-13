import fs from 'node:fs';
import path from 'node:path';
import { app } from '@platform';
import {
  DEFAULT_SPEECH_MODEL_ID,
  SPEECH_MAX_SECONDS,
  SPEECH_MODEL_IDS,
  SPEECH_SAMPLE_RATE,
  type SpeechDownloadProgressDto,
  type SpeechErrorCode,
  type SpeechModelDto,
  type SpeechModelId,
  type SpeechStatusDto,
  type SpeechTranscribeResult,
  type VoiceSession,
} from '@shared/types/speech';
import { downloadedBytes, downloadModel, isModelReady } from '../memory/embedding/downloader';
import { downloadArchiveModel } from './archive';
import type { SpeechEngine, SpeechEngineStream } from './engine';
import { geminiApiKeyFromSettings, openGeminiLiveStream, parseVocabulary } from './gemini';
import {
  HANBAO_ENGINE,
  hanbaoEngineDir,
  recognizerConfig,
  SPEECH_MODELS,
  type SpeechModelSpec,
  speechModelDirName,
  speechModelIdFromSettings,
} from './model';
import {
  installSpeechRuntime,
  isSpeechRuntimeReady,
  SHERPA_ONNX_VERSION,
  sherpaPlatformPackage,
  speechRuntimeDir,
  speechRuntimeWrapperDir,
} from './runtime';
import { createPauseSegmenter } from './segment';
import { acceptCorrection, joinSegments, normalizeTranscript } from './text';

const IDLE_UNLOAD_MS = 10 * 60_000;
/** 原版 WeType 语音通道的 Notify 保活间隔 */
const WETYPE_KEEPALIVE_MS = 180_000;
const CORRECTION_TIMEOUT_MS = 20_000;
const MAX_SAMPLES = SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS;

interface SpeechTestHooks {
  root: string;
  platform: string;
  arch: string;
  createEngine: (spec: SpeechModelSpec, dir: string) => Promise<SpeechEngine>;
}

/** 返回模型原始输出；null = 纠错模型不可用（未下载 / 未配置） */
export type SpeechCorrector = (text: string) => Promise<string | null>;

interface DownloadTask {
  controller: AbortController;
  settled: Promise<void>;
}

interface RuntimeInstall {
  promise: Promise<void>;
  controller: AbortController;
  /** 仍在等这次安装的下载数 */
  waiters: number;
}

let hooks: SpeechTestHooks | null = null;
let enabled = false;
let selected: SpeechModelId = DEFAULT_SPEECH_MODEL_ID;
let correctionEnabled = false;
let geminiApiKey: string | null = null;
let vocabulary: string[] = [];
let corrector: SpeechCorrector | null = null;
const downloads = new Map<SpeechModelId, DownloadTask>();
let runtimeInstall: RuntimeInstall | null = null;
let engine: { id: SpeechModelId; promise: Promise<SpeechEngine> } | null = null;
let activeSessions = 0;
let idleTimer: NodeJS.Timeout | null = null;
let progressSink: ((progress: SpeechDownloadProgressDto) => void) | null = null;
let lastAvailable = false;
const availabilityListeners = new Set<(available: boolean) => void>();

/** 仅供测试：临时目录 + 假引擎，不碰真实 userData 与原生插件 */
export function __setSpeechTestHooks(next: SpeechTestHooks | null): void {
  hooks = next;
  enabled = false;
  selected = DEFAULT_SPEECH_MODEL_ID;
  correctionEnabled = false;
  geminiApiKey = null;
  vocabulary = [];
  corrector = null;
  lastAvailable = false;
  downloads.clear();
  runtimeInstall = null;
  unloadEngine();
  activeSessions = 0;
  availabilityListeners.clear();
}

export function setSpeechProgressSink(
  sink: ((progress: SpeechDownloadProgressDto) => void) | null
): void {
  progressSink = sink;
}

export function setSpeechCorrector(next: SpeechCorrector | null): void {
  corrector = next;
}

export function onSpeechAvailabilityChange(listener: (available: boolean) => void): () => void {
  availabilityListeners.add(listener);
  return () => {
    availabilityListeners.delete(listener);
  };
}

function speechRoot(): string {
  return hooks?.root ?? path.join(app.getPath('userData'), 'speech');
}

function platformPackage(): string | null {
  return sherpaPlatformPackage(hooks?.platform ?? process.platform, hooks?.arch ?? process.arch);
}

function runtimeDir(): string {
  return speechRuntimeDir(path.join(speechRoot(), 'runtime'), SHERPA_ONNX_VERSION);
}

function modelDir(id: SpeechModelId): string {
  return path.join(speechRoot(), 'models', speechModelDirName(id));
}

function runtimeReady(): boolean {
  const pkg = platformPackage();
  return pkg !== null && isSpeechRuntimeReady(runtimeDir(), pkg);
}

/** hanbao 预编译只有 macOS arm64 */
function hanbaoSupported(): boolean {
  return (
    (hooks?.platform ?? process.platform) === 'darwin' && (hooks?.arch ?? process.arch) === 'arm64'
  );
}

function hanbaoDir(): string {
  return hanbaoEngineDir(path.join(speechRoot(), 'runtime'));
}

function modelSupported(id: SpeechModelId): boolean {
  return id !== 'hanbao' || hanbaoSupported();
}

function modelReady(id: SpeechModelId): boolean {
  const spec = SPEECH_MODELS[id];
  if (id === 'wetype') return true;
  if (spec.remote) return geminiApiKey !== null;
  if (id === 'hanbao') {
    return (
      hanbaoSupported() &&
      isModelReady(hanbaoDir(), HANBAO_ENGINE) &&
      isModelReady(modelDir(id), spec)
    );
  }
  return runtimeReady() && isModelReady(modelDir(id), spec);
}

export function speechAvailable(): boolean {
  return enabled && modelReady(selected);
}

function notifyAvailability(): void {
  const available = speechAvailable();
  if (available === lastAvailable) return;
  lastAvailable = available;
  for (const listener of [...availabilityListeners]) {
    try {
      listener(available);
    } catch {}
  }
}

/** settings.json 的 state 按 unknown 收窄；关闭或换模型即卸载常驻引擎 */
export function syncSpeechFromSettings(state: Record<string, unknown>): void {
  enabled = state.voiceInputEnabled === true;
  correctionEnabled = state.voiceCorrectionEnabled === true;
  geminiApiKey = geminiApiKeyFromSettings(state);
  vocabulary = parseVocabulary(state.voiceVocabulary);
  const next = speechModelIdFromSettings(state);
  if (!enabled || next !== selected) unloadEngine();
  selected = next;
  notifyAvailability();
}

function archivedBytes(id: SpeechModelId): number {
  try {
    return fs.statSync(path.join(modelDir(id), '.archive.part')).size;
  } catch {
    return 0;
  }
}

function modelDto(id: SpeechModelId): SpeechModelDto {
  const spec = SPEECH_MODELS[id];
  const ready = modelReady(id);
  return {
    id,
    streaming: spec.streaming,
    remote: spec.remote === true,
    approxBytes: spec.approxBytes,
    memoryBytes: spec.memoryBytes,
    downloadedBytes:
      spec.archive && !ready ? archivedBytes(id) : downloadedBytes(modelDir(id), spec),
    state: downloads.has(id) ? 'downloading' : ready ? 'ready' : 'missing',
  };
}

export function getSpeechStatus(): SpeechStatusDto {
  const models = SPEECH_MODEL_IDS.filter(modelSupported).map(modelDto);
  const current = models.find((model) => model.id === selected);
  const local = platformPackage() !== null;
  return {
    // 选中的模型本机不支持时仍给出列表，让用户改选
    state: current
      ? current.remote || local
        ? current.state
        : 'unsupported'
      : local
        ? 'missing'
        : 'unsupported',
    selected,
    models,
  };
}

/**
 * 多个模型同时下载时共用一次引擎安装。安装用自己的取消信号：某个下载取消只放弃等待，
 * 等待者全部取消后才中止安装，否则取消一个会把同时在等运行时的其它下载一起弄失败。
 */
async function ensureRuntime(pkg: string, signal: AbortSignal): Promise<void> {
  if (isSpeechRuntimeReady(runtimeDir(), pkg)) return;
  if (!runtimeInstall) {
    const controller = new AbortController();
    const install: RuntimeInstall = {
      controller,
      waiters: 0,
      promise: installSpeechRuntime({
        dir: runtimeDir(),
        platformPackage: pkg,
        version: SHERPA_ONNX_VERSION,
        signal: controller.signal,
      }).finally(() => {
        if (runtimeInstall === install) runtimeInstall = null;
      }),
    };
    runtimeInstall = install;
  }
  const install = runtimeInstall;
  install.waiters += 1;
  try {
    await new Promise<void>((resolve, reject) => {
      const giveUp = () => reject(signal.reason);
      // 先挂上结果处理：即便本调用方已放弃，被中止的安装也不会成为未处理的 rejection
      install.promise
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', giveUp));
      if (signal.aborted) giveUp();
      else signal.addEventListener('abort', giveUp, { once: true });
    });
  } finally {
    install.waiters -= 1;
    if (install.waiters === 0 && signal.aborted) install.controller.abort();
  }
}

export async function startSpeechDownload(id: SpeechModelId): Promise<boolean> {
  const pkg = platformPackage();
  const spec = SPEECH_MODELS[id];
  // hanbao 用自己的引擎，不装 sherpa 运行时
  const hanbao = id === 'hanbao';
  if (spec.remote || downloads.has(id) || (hanbao ? !hanbaoSupported() : !pkg)) return false;
  const controller = new AbortController();
  let settle!: () => void;
  const task = { controller, settled: new Promise<void>((resolve) => (settle = resolve)) };
  downloads.set(id, task);
  const fileCount = (spec.archive ? 1 : spec.files.length) + 1;
  const emit = (progress: Omit<SpeechDownloadProgressDto, 'fileCount' | 'modelId'>) => {
    if (downloads.get(id) === task) progressSink?.({ ...progress, modelId: id, fileCount });
  };
  let error: string | undefined;
  try {
    if (hanbao) {
      if (!isModelReady(hanbaoDir(), HANBAO_ENGINE)) {
        await downloadArchiveModel(HANBAO_ENGINE, hanbaoDir(), {
          signal: controller.signal,
          onProgress: (p) =>
            emit({ file: p.file, fileIndex: 0, received: p.received, total: p.total }),
        });
      }
    } else if (pkg && !isSpeechRuntimeReady(runtimeDir(), pkg)) {
      emit({ file: pkg, fileIndex: 0, received: 0, total: null });
      await ensureRuntime(pkg, controller.signal);
    }
    controller.signal.throwIfAborted();
    const options = {
      signal: controller.signal,
      onProgress: (p: {
        file: string;
        fileIndex: number;
        received: number;
        total: number | null;
      }) =>
        emit({ file: p.file, fileIndex: p.fileIndex + 1, received: p.received, total: p.total }),
    };
    if (spec.archive) await downloadArchiveModel(spec, modelDir(id), options);
    else await downloadModel(spec, modelDir(id), options);
    return true;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    return false;
  } finally {
    emit({ file: '', fileIndex: 0, received: 0, total: null, done: true, error });
    if (downloads.get(id) === task) downloads.delete(id);
    settle();
    notifyAvailability();
  }
}

export function cancelSpeechDownload(id: SpeechModelId): boolean {
  const task = downloads.get(id);
  if (!task || task.controller.signal.aborted) return false;
  task.controller.abort();
  return true;
}

/** 删模型必删；最后一个模型删掉时顺带删引擎（Windows 上已加载的原生插件删不掉，留着约 30MB） */
export async function deleteSpeechModel(id: SpeechModelId): Promise<boolean> {
  if (SPEECH_MODELS[id].remote) return false;
  const task = downloads.get(id);
  cancelSpeechDownload(id);
  await task?.settled;
  if (engine?.id === id) unloadEngine();
  try {
    fs.rmSync(modelDir(id), { recursive: true, force: true });
    if (id === 'hanbao') fs.rmSync(hanbaoDir(), { recursive: true, force: true });
    if (!SPEECH_MODEL_IDS.some((other) => fs.existsSync(modelDir(other)))) {
      try {
        fs.rmSync(runtimeDir(), { recursive: true, force: true });
      } catch {}
    }
    return true;
  } catch {
    return false;
  } finally {
    notifyAvailability();
    // 各窗口都按 done 事件重查状态：设置窗删了当前模型，主窗口的麦克风要跟着消失
    progressSink?.({
      modelId: id,
      file: '',
      fileIndex: 0,
      fileCount: 0,
      received: 0,
      total: null,
      done: true,
    });
  }
}

function unloadEngine(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const current = engine;
  engine = null;
  void current?.promise.then(
    (loaded) => loaded.dispose(),
    () => {}
  );
}

function scheduleIdleUnload(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (activeSessions > 0 || !engine) return;
  idleTimer = setTimeout(unloadEngine, IDLE_UNLOAD_MS);
  idleTimer.unref?.();
}

function loadEngine(): Promise<SpeechEngine> {
  if (engine?.id !== selected) {
    unloadEngine();
    const spec = SPEECH_MODELS[selected];
    const pending = (hooks?.createEngine ?? createEngine)(spec, modelDir(selected));
    const entry = { id: selected, promise: pending };
    engine = entry;
    pending.catch(() => {
      if (engine === entry) engine = null;
    });
  }
  return engine.promise;
}

async function createEngine(spec: SpeechModelSpec, dir: string): Promise<SpeechEngine> {
  if (spec.id === 'wetype') {
    const { createWetypeChannelPool, openWetypeChannel, openWetypeStream } = await import(
      './wetype'
    );
    const identityFile = path.join(speechRoot(), 'wetype.json');
    const pool = createWetypeChannelPool({
      open: () => openWetypeChannel(identityFile),
      keepaliveMs: WETYPE_KEEPALIVE_MS,
    });
    return {
      transcribe: () => Promise.reject(new Error('cloud speech model only streams')),
      openStream: () => openWetypeStream({ openChannel: pool.lease }),
      prewarm: pool.prewarm,
      dispose: pool.dispose,
    };
  }
  if (spec.remote) {
    // 凭证与词表在开录时读取：改设置不必重建引擎
    return {
      transcribe: () => Promise.reject(new Error('cloud speech model only streams')),
      openStream: () => {
        if (!geminiApiKey) throw new Error('no Gemini API key');
        return openGeminiLiveStream({ apiKey: geminiApiKey, vocabulary });
      },
      dispose: () => {},
    };
  }
  if (spec.id === 'hanbao') {
    const bundle = hanbaoDir();
    const [{ spawn }, { createHanbaoEngine }] = await Promise.all([
      import('node:child_process'),
      import('./hanbao'),
    ]);
    const model = path.join(dir, 'model.flute');
    return createHanbaoEngine({
      start: () =>
        spawn(path.join(bundle, 'hanbao'), ['--pipe', model], {
          env: { ...process.env, HB_LIBDIR: path.join(bundle, 'libs') },
          stdio: ['pipe', 'pipe', 'ignore'],
        }),
    });
  }
  const { createWorkerEngine } = await import('./engine');
  const { kind, config } = recognizerConfig(spec, dir);
  return createWorkerEngine({ wrapperDir: speechRuntimeWrapperDir(runtimeDir()), kind, config });
}

async function correct(text: string): Promise<string> {
  const run = corrector;
  if (!run) return text;
  let timer: NodeJS.Timeout | undefined;
  try {
    const output = await Promise.race([
      run(text),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CORRECTION_TIMEOUT_MS);
      }),
    ]);
    return output === null ? text : acceptCorrection(text, output);
  } catch (error) {
    console.warn('[speech] correction failed:', error);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function rejectedSession(error: SpeechErrorCode): VoiceSession {
  return {
    push: () => {},
    finish: () => Promise.resolve({ ok: false, error }),
    cancel: () => {},
  };
}

/** 用户即将开录（按下麦克风）：云端模型提前建连，省掉首字前的握手 */
export function prewarmSpeech(): void {
  if (!enabled || !SPEECH_MODELS[selected].remote || !modelReady(selected)) return;
  void loadEngine().then(
    (ready) => ready.prewarm?.(),
    () => {}
  );
  scheduleIdleUnload();
}

/**
 * 录音会话：边录边推 16kHz PCM。流式模型逐块解码并经 onPartial 给中间结果；
 * 整段模型按停顿逐句识别并给中间结果。
 * 开启纠错时先把原文标记为纠错中给出，再返回纠错后的定稿。
 */
export function openSpeechSession(
  onPartial: (text: string, correcting: boolean) => void
): VoiceSession {
  if (!enabled) return rejectedSession('disabled');
  if (!modelReady(selected)) return rejectedSession('not-ready');
  const spec = SPEECH_MODELS[selected];
  const loaded = loadEngine();
  activeSessions++;
  scheduleIdleUnload();

  let phase: 'open' | 'finishing' | 'closed' = 'open';
  let total = 0;
  let overflow = false;
  let failed = false;
  let lastPartial = '';
  const stream: Promise<SpeechEngineStream> | null = spec.streaming
    ? loaded.then((ready) => ready.openStream())
    : null;
  stream?.catch(() => {
    failed = true;
  });
  const segmenter = spec.streaming ? null : createPauseSegmenter();
  const sentences: string[] = [];
  let chain: Promise<void> = Promise.resolve();
  const recognize = async (samples: Float32Array) =>
    normalizeTranscript(await (await loaded).transcribe(samples));

  const close = () => {
    if (phase === 'closed') return;
    phase = 'closed';
    activeSessions--;
    scheduleIdleUnload();
  };
  const partial = (text: string, correcting = false) => {
    if (phase === 'closed' || !text || (text === lastPartial && !correcting)) return;
    lastPartial = text;
    onPartial(text, correcting);
  };

  return {
    push: (samples) => {
      if (phase !== 'open' || overflow || samples.length === 0) return;
      total += samples.length;
      if (total > MAX_SAMPLES) {
        overflow = true;
        return;
      }
      if (segmenter) {
        for (const sentence of segmenter.push(samples)) {
          chain = chain
            .then(async () => {
              if (phase === 'closed') return;
              sentences.push(await recognize(sentence));
              partial(joinSegments(sentences));
            })
            .catch(() => {
              failed = true;
            });
        }
        return;
      }
      chain = chain
        .then(async () => partial(normalizeTranscript(await (await stream!).accept(samples))))
        .catch(() => {
          failed = true;
        });
    },
    finish: async (): Promise<SpeechTranscribeResult> => {
      if (phase !== 'open') return { ok: false, error: 'failed' };
      phase = 'finishing';
      try {
        if (overflow || total === 0) {
          void stream?.then(
            (s) => s.cancel(),
            () => {}
          );
          return { ok: false, error: 'invalid-audio' };
        }
        let text: string;
        if (stream) {
          await chain;
          if (failed) throw new Error('streaming decode failed');
          text = await (await stream).finish();
        } else {
          const tail = segmenter!.flush();
          await chain;
          if (failed) throw new Error('sentence decode failed');
          if (tail.speech || sentences.length === 0) sentences.push(await recognize(tail.samples));
          text = joinSegments(sentences);
        }
        text = normalizeTranscript(text);
        if (text && correctionEnabled && corrector) {
          partial(text, true);
          text = await correct(text);
        }
        return { ok: true, text };
      } catch (error) {
        console.warn('[speech] transcription failed:', error);
        return { ok: false, error: 'failed' };
      } finally {
        close();
      }
    },
    cancel: () => {
      if (phase !== 'open') return;
      close();
      segmenter?.flush();
      void stream?.then(
        (s) => s.cancel(),
        () => {}
      );
    },
  };
}
