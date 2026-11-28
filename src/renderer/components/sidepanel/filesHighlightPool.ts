import { WorkerPoolManager } from '@pierre/diffs/worker';
import DiffWorker from '@pierre/diffs/worker/worker.js?worker';
import { CODE_THEME, LANGS } from '@/components/chat/codeHighlighter';

let pool: WorkerPoolManager | undefined;

/**
 * Files 编辑器专用的高亮 worker 池，首次打开源码时才建。
 * useTokenTransformer 让 worker 产出的 AST 可直接交给编辑器：挂编辑器时复用它，
 * 不在主线程重跑整文件 shiki（60KB 源码约 2s）。全局 DiffWorkerPool 不开这项，聊天 diff 不受影响。
 */
export function filesHighlightPool(): WorkerPoolManager | undefined {
  if (typeof Worker === 'undefined') return undefined;
  pool ??= new WorkerPoolManager(
    { workerFactory: () => new DiffWorker(), poolSize: 1 },
    {
      theme: CODE_THEME,
      langs: [...LANGS],
      preferredHighlighter: 'shiki-js',
      useTokenTransformer: true,
    }
  );
  return pool;
}
