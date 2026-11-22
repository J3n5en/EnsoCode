import { createHash } from 'node:crypto';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('./appPaths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./appPaths')>();
  return {
    ...actual,
    userDataPath: () => env.userData,
    inferUserDataFromMemoryRoot: actual.inferUserDataFromMemoryRoot,
  };
});
vi.mock('electron', () => ({ app: { getPath: () => env.userData } }));
vi.mock('./memoryHost', () => ({ releaseMemoryChatSlot: vi.fn(async () => true) }));
vi.mock('./llama/chatModels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llama/chatModels')>();
  return {
    ...actual,
    resolveChatModelSpec: (id: string) => {
      const spec = actual.resolveChatModelSpec(id);
      return (
        spec && {
          ...spec,
          files: spec.files.map((file) => ({
            ...file,
            sha256: createHash('sha256')
              .update(Buffer.from([4, 5, 6]))
              .digest('hex'),
          })),
        }
      );
    },
  };
});

import {
  cancelChatModelDownload,
  deleteChatModel,
  listChatModels,
  setChatModelProgressSink,
  startChatModelDownload,
} from './chatModels';
import { downloadModel } from './memory/embedding/downloader';
import { resolveEmbeddingModelSpec } from './memory/embedding/registry';
import {
  cancelEmbeddingModelDownload,
  deleteEmbeddingModel,
  listEmbeddingModels,
  setEmbeddingProgressSink,
  startEmbeddingModelDownload,
} from './memoryModels';

const managers = [
  {
    name: 'chat',
    id: 'local:qwen3-0.6b-chat',
    directory: 'chat-models/local_qwen3-0.6b-chat',
    file: 'Qwen3-0.6B-UD-Q4_K_XL.gguf',
    start: startChatModelDownload,
    cancel: cancelChatModelDownload,
    remove: deleteChatModel,
    list: listChatModels,
    sink: setChatModelProgressSink,
  },
  {
    name: 'embedding',
    id: 'local:qwen3-0.6b-gguf',
    directory: 'models/local_qwen3-0.6b-gguf',
    file: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
    start: startEmbeddingModelDownload,
    cancel: cancelEmbeddingModelDownload,
    remove: deleteEmbeddingModel,
    list: listEmbeddingModels,
    sink: setEmbeddingProgressSink,
  },
];

let streams: ReadableStreamDefaultController<Uint8Array>[];
let tasks: Promise<unknown>[];

function streamingResponse(bytes: number[], cancel?: () => Promise<void>) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streams.push(controller);
        controller.enqueue(Uint8Array.from(bytes));
      },
      cancel,
    }),
    { status: 200 }
  );
}

beforeEach(() => {
  env.userData = mkdtempSync(path.join(tmpdir(), 'enso-download-lifecycle-'));
  streams = [];
  tasks = [];
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const manager of managers) {
    manager.sink(null);
    manager.cancel(manager.id);
  }
  for (const stream of streams) {
    try {
      stream.error(new DOMException('Aborted', 'AbortError'));
    } catch {}
  }
  await vi.runAllTimersAsync();
  await Promise.all(tasks);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(env.userData, { recursive: true, force: true });
});

describe('checksum cancellation', () => {
  it('chat 校验中取消成功后不发布 ready，start 返回 false 且文件不改名', async () => {
    const manager = managers[0];
    const directory = path.join(env.userData, 'memory', manager.directory);
    // 仅替代哈希读取用到的流事件，文件专有字段不参与本测试。
    const hashStream = new PassThrough();
    const reading = vi
      .spyOn(fs, 'createReadStream')
      .mockReturnValueOnce(hashStream as unknown as fs.ReadStream);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => streamingResponse([4, 5, 6]))
    );
    const download = manager.start(manager.id);
    tasks.push(download);
    try {
      await vi.advanceTimersByTimeAsync(0);
      streams[0].close();
      await vi.advanceTimersByTimeAsync(0);
      expect(reading).toHaveBeenCalledTimes(1);
      expect(manager.cancel(manager.id)).toBe(true);
      hashStream.end(Buffer.from([4, 5, 6]));
      await vi.advanceTimersByTimeAsync(0);
      expect(await download).toBe(false);
      expect(manager.list().find((model) => model.id === manager.id)?.state).toBe('missing');
      expect(existsSync(path.join(directory, '.ready'))).toBe(false);
      expect(existsSync(path.join(directory, manager.file))).toBe(false);
      expect(readFileSync(path.join(directory, `${manager.file}.part`))).toEqual(
        Buffer.from([4, 5, 6])
      );
    } finally {
      if (!hashStream.writableEnded) hashStream.end(Buffer.from([4, 5, 6]));
    }
  });
});

describe('download sink state refresh', () => {
  it.each(['success', 'cancel', 'fail'] as const)(
    'auto %s 的终态通知内立即刷新已不再是 downloading',
    async (outcome) => {
      const manager = managers[1];
      const spec = resolveEmbeddingModelSpec(manager.id);
      if (!spec) throw new Error('missing fixture spec');
      const events: { done: boolean; state: string | undefined; error: string | undefined }[] = [];
      const sink = vi.fn((event: { done?: boolean; error?: string }) => {
        events.push({
          done: event.done === true,
          error: event.error,
          state: manager.list().find((model) => model.id === manager.id)?.state,
        });
      });
      manager.sink(sink);
      manager.sink(sink);
      vi.stubGlobal(
        'fetch',
        vi.fn(() => streamingResponse([1, 2, 3]))
      );
      const automatic = downloadModel(spec, path.join(env.userData, 'memory', manager.directory), {
        sources: ['huggingface'],
        maxAttempts: 1,
      }).then(
        () => true,
        () => false
      );
      tasks.push(automatic);
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === 'success') streams[0].close();
      else if (outcome === 'cancel') {
        expect(manager.cancel(manager.id)).toBe(true);
        streams[0].error(new DOMException('Aborted', 'AbortError'));
      } else streams[0].error(new Error('network failed'));
      expect(await automatic).toBe(outcome === 'success');
      expect(events.filter((event) => event.done)).toEqual([
        {
          done: true,
          state: outcome === 'success' ? 'ready' : 'missing',
          error: outcome === 'success' ? undefined : expect.any(String),
        },
      ]);
      expect(events.some((event) => !event.done && event.state === 'downloading')).toBe(true);
      expect(sink.mock.calls.every(([event]) => !('dir' in event))).toBe(true);
    }
  );

  it('替换或移除sink会退订旧监听，不把后续进度或终态发到旧窗口', async () => {
    const manager = managers[1];
    const spec = resolveEmbeddingModelSpec(manager.id);
    if (!spec) throw new Error('missing fixture spec');
    const firstSink = vi.fn();
    const secondSink = vi.fn();
    manager.sink(firstSink);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => streamingResponse([1, 2, 3]))
    );
    const automatic = downloadModel(spec, path.join(env.userData, 'memory', manager.directory));
    tasks.push(automatic);
    await vi.advanceTimersByTimeAsync(0);
    expect(firstSink).toHaveBeenCalledTimes(1);
    manager.sink(secondSink);
    streams[0].enqueue(Uint8Array.from([4]));
    await vi.advanceTimersByTimeAsync(0);
    expect(firstSink).toHaveBeenCalledTimes(1);
    expect(secondSink).toHaveBeenCalledTimes(1);
    manager.sink(null);
    streams[0].close();
    await automatic;
    expect(firstSink).toHaveBeenCalledTimes(1);
    expect(secondSink).toHaveBeenCalledTimes(1);
  });

  it('auto被explicit加入时只发一次终态，sink刷新也不保留显式running状态', async () => {
    const manager = managers[1];
    const spec = resolveEmbeddingModelSpec(manager.id);
    if (!spec) throw new Error('missing fixture spec');
    const states: (string | undefined)[] = [];
    manager.sink((event) => {
      if (event.done) states.push(manager.list().find((model) => model.id === manager.id)?.state);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => streamingResponse([1, 2, 3]))
    );
    const automatic = downloadModel(spec, path.join(env.userData, 'memory', manager.directory));
    tasks.push(automatic);
    await vi.advanceTimersByTimeAsync(0);
    const explicit = manager.start(manager.id);
    tasks.push(explicit);
    await vi.advanceTimersByTimeAsync(0);
    streams[0].close();
    await automatic;
    expect(await explicit).toBe(true);
    expect(states).toEqual(['ready']);
  });
});

describe('automatic embedding download ownership', () => {
  it('只有自动任务时列表仍显示下载中，显式取消和删除不能绕过它', async () => {
    const manager = managers[1];
    const spec = resolveEmbeddingModelSpec(manager.id);
    if (!spec) throw new Error('missing fixture spec');
    const directory = path.join(env.userData, 'memory', manager.directory);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => streamingResponse([1, 2, 3]))
    );
    const automatic = downloadModel(spec, directory).then(
      () => true,
      () => false
    );
    tasks.push(automatic);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.list().find((model) => model.id === manager.id)?.state).toBe('downloading');
    expect(manager.cancel(manager.id)).toBe(true);
    expect(manager.remove(manager.id)).toBe(false);
    expect(existsSync(path.join(directory, `${manager.file}.part`))).toBe(true);
    streams[0].error(new DOMException('Aborted', 'AbortError'));
    expect(await automatic).toBe(false);
    expect(manager.remove(manager.id)).toBe(true);
  });
});

describe.each(managers)('$name download lifecycle', (manager) => {
  const start = () => {
    const task = manager.start(manager.id);
    tasks.push(task);
    return task;
  };
  const state = () => manager.list().find((model) => model.id === manager.id)?.state;
  const finalPath = () => path.join(env.userData, 'memory', manager.directory, manager.file);

  it('503 退避取消后 50ms 重开，旧任务结束不会清掉新下载或发旧完成事件', async () => {
    const network = vi
      .fn()
      .mockResolvedValueOnce(new Response('temporary', { status: 503 }))
      .mockImplementation(() => streamingResponse([4, 5, 6]));
    vi.stubGlobal('fetch', network);
    const progress = vi.fn();
    manager.sink(progress);
    const first = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.cancel(manager.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    const second = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(network).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(950);
    expect(await first).toBe(false);
    expect(network).toHaveBeenCalledTimes(2);
    expect(state()).toBe('downloading');
    expect(progress.mock.calls.flat().filter((event) => event.done)).toEqual([]);
    expect(await start()).toBe(false);
    expect(readFileSync(`${finalPath()}.part`)).toEqual(Buffer.from([4, 5, 6]));
    expect(manager.cancel(manager.id)).toBe(true);
    streams[0].error(new DOMException('Aborted', 'AbortError'));
    expect(await second).toBe(false);
    expect(state()).toBe('missing');
  });

  it('取消信号发出后仍等待旧流关闭，重下载不并发写同一个 .part', async () => {
    const network = vi
      .fn()
      .mockImplementationOnce(() => streamingResponse([1, 2, 3]))
      .mockImplementation(() => streamingResponse([4, 5, 6]));
    vi.stubGlobal('fetch', network);
    const first = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(readFileSync(`${finalPath()}.part`)).toEqual(Buffer.from([1, 2, 3]));
    manager.cancel(manager.id);
    const second = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(network).toHaveBeenCalledTimes(1);
    streams[0].error(new DOMException('Aborted', 'AbortError'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toBe(false);
    expect(network).toHaveBeenCalledTimes(2);
    expect(readFileSync(`${finalPath()}.part`)).toEqual(Buffer.from([4, 5, 6]));
    expect(await start()).toBe(false);
    streams[1].close();
    expect(await second).toBe(true);
    expect(readFileSync(finalPath())).toEqual(Buffer.from([4, 5, 6]));
    expect(existsSync(`${finalPath()}.part`)).toBe(false);
    expect(state()).toBe('ready');
  });

  it('排队重开也可取消，再次重开仍等待最初任务退出且不发陈旧进度', async () => {
    let releaseCancel = () => {};
    const network = vi
      .fn()
      .mockImplementationOnce(() =>
        streamingResponse(
          [1, 2, 3],
          () =>
            new Promise<void>((resolve) => {
              releaseCancel = resolve;
            })
        )
      )
      .mockImplementation(() => streamingResponse([4, 5, 6]));
    vi.stubGlobal('fetch', network);
    const progress = vi.fn();
    manager.sink(progress);
    const first = start();
    await vi.advanceTimersByTimeAsync(0);
    manager.cancel(manager.id);
    const second = start();
    manager.cancel(manager.id);
    const third = start();
    progress.mockClear();
    streams[0].enqueue(Uint8Array.from([9]));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(network).toHaveBeenCalledTimes(1);
      expect(progress).not.toHaveBeenCalled();
    } finally {
      releaseCancel();
      streams[0].error(new DOMException('Aborted', 'AbortError'));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(network).toHaveBeenCalledTimes(2);
    expect(state()).toBe('downloading');
    expect(manager.cancel(manager.id)).toBe(true);
    streams[1].error(new DOMException('Aborted', 'AbortError'));
    expect(await third).toBe(false);
  });

  it('删除不会在旧下载仍持有文件时移除目录', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => streamingResponse([1, 2, 3]))
    );
    const first = start();
    await vi.advanceTimersByTimeAsync(0);
    const removal = manager.remove(manager.id);
    if (removal instanceof Promise) tasks.push(removal);
    await vi.advanceTimersByTimeAsync(0);
    expect(existsSync(`${finalPath()}.part`)).toBe(true);
    if (manager.name === 'embedding') expect(removal).toBe(false);
    else expect(await start()).toBe(false);
    streams[0].error(new DOMException('Aborted', 'AbortError'));
    expect(await first).toBe(false);
    if (manager.name === 'chat') expect(await removal).toBe(true);
    else expect(await manager.remove(manager.id)).toBe(true);
    expect(existsSync(path.dirname(finalPath()))).toBe(false);
  });
});
