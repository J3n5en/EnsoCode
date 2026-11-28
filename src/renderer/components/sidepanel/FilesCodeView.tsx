import type { FileOptions } from '@pierre/diffs';
import type { EditorOptions } from '@pierre/diffs/edit';
import { File, Virtualizer, WorkerPoolContext } from '@pierre/diffs/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { filesHighlightPool } from './filesHighlightPool';

/** 内容寻址的高亮缓存 key：同名同内容复用 worker 结果，内容变了绝不命中旧 AST */
export function fileCacheKey(name: string, contents: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < contents.length; i += 1) {
    hash ^= contents.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `files:${name}:${contents.length}:${(hash >>> 0).toString(36)}`;
}

const DEFAULT_LINE_HEIGHT = 20;

/**
 * Files 面板源码视图：先用 worker 池高亮只读展示，worker 结果落进缓存后再挂编辑器。
 * 编辑会话会把高亮切回主线程，提前挂就会在主线程同步跑整文件 shiki、卡住侧栏展开动画。
 * 父级按文件版本换 key 重挂（磁盘刷新、重新载入都会升版本），挂载期间文本只由编辑器改。
 */
export function FilesCodeView({
  name,
  initialContents,
  revealLine,
  editorOptions,
  options,
}: {
  name: string;
  /** 挂载时的文本快照：之后的改动由编辑器自己持有，回灌会被当成整份替换、在主线程重跑整文件高亮 */
  initialContents: string;
  /** 打开时要露出的行：编辑器挂上前先把只读视图滚过去 */
  revealLine?: number;
  editorOptions: EditorOptions<undefined>;
  options: FileOptions<undefined>;
}) {
  const pool = filesHighlightPool();
  const [file] = useState(() => ({
    name,
    contents: initialContents,
    cacheKey: fileCacheKey(name, initialContents),
  }));
  const [editable, setEditable] = useState(
    () => pool === undefined || pool.getFileResultCache(file) !== undefined
  );
  const [poolReady, setPoolReady] = useState(() => pool === undefined || pool.isInitialized());

  useEffect(() => {
    if (poolReady || !pool) return;
    let alive = true;
    const ready = () => {
      if (alive) setPoolReady(true);
    };
    pool.initialize().then(ready, ready);
    return () => {
      alive = false;
    };
  }, [pool, poolReady]);

  useEffect(() => {
    if (editable || !pool) return;
    let alive = true;
    const ready = () => {
      if (alive) setEditable(true);
    };
    pool.primeFileHighlightCache(file).then(ready, ready);
    return () => {
      alive = false;
    };
  }, [editable, file, pool]);

  const rootRef = useRef<HTMLDivElement>(null);
  const [initialLine] = useState(revealLine);
  useLayoutEffect(() => {
    if (!poolReady || editable || !initialLine) return;
    const scroller = rootRef.current?.firstElementChild;
    if (!(scroller instanceof HTMLElement)) return;
    const sample = scroller
      .querySelector('diffs-container')
      ?.shadowRoot?.querySelector<HTMLElement>('[data-line]');
    const lineHeight = sample?.getBoundingClientRect().height || DEFAULT_LINE_HEIGHT;
    scroller.scrollTop = Math.max(0, (initialLine - 1) * lineHeight - scroller.clientHeight / 3);
  }, [editable, initialLine, poolReady]);

  return (
    <WorkerPoolContext.Provider value={pool}>
      <div ref={rootRef} className="contents">
        <Virtualizer style={{ height: '100%', overflow: 'auto' }}>
          {poolReady && (
            <File file={file} edit={editable} editorOptions={editorOptions} options={options} />
          )}
        </Virtualizer>
      </div>
    </WorkerPoolContext.Provider>
  );
}
