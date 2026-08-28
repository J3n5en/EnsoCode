import type { AttachedImage } from '@enso/pair';
import { useMemo, useRef, useState } from 'react';
import type { ConnState, SessionView } from './client';
import { compressImage } from './image';

interface Props {
  title: string;
  projectName: string;
  view: SessionView | null;
  connState: ConnState;
  stateLabel: string;
  onBack(): void;
  onSend(text: string, images: AttachedImage[]): void;
  onAbort(): void;
  onApproval(requestId: string, decision: 'allow' | 'allowSession' | 'deny'): void;
  onAsk(requestId: string, answer: string): void;
}

/** 会话页：时间线 + 审批条 + composer（running 时发送即 steer） */
export function ChatScreen(props: Props) {
  const { view } = props;
  const [text, setText] = useState('');
  const [images, setImages] = useState<{ id: string; image: AttachedImage }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const running = view?.status === 'running';

  const messages = useMemo(
    () => (view ? [...view.messages.values()].sort((a, b) => a.index - b.index) : []),
    [view]
  );

  // 新消息到达才滚到底（避免每次 render 都抢滚动位置）
  const lastCount = useRef(0);
  if (messages.length !== lastCount.current) {
    lastCount.current = messages.length;
    queueMicrotask(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }));
  }

  const pickImages = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files).slice(0, 4)) {
      try {
        const image = await compressImage(file);
        setImages((prev) => [...prev, { id: crypto.randomUUID(), image }]);
      } catch (e) {
        setError(e instanceof Error ? e.message : '图片处理失败');
      }
    }
  };

  const submit = () => {
    if (!text.trim() && images.length === 0) return;
    props.onSend(
      text.trim(),
      images.map((i) => i.image)
    );
    setText('');
    setImages([]);
  };

  return (
    <div className="screen chat-screen">
      <header className="topbar">
        <button type="button" className="btn ghost sm" onClick={props.onBack}>
          ‹ 返回
        </button>
        <div className="chat-title">
          <span className="title">{props.title}</span>
          <span className="project">{props.projectName}</span>
        </div>
        <span className={`state ${props.connState}`}>{props.stateLabel}</span>
      </header>

      <div className="timeline">
        {messages.length === 0 && <p className="empty">还没有消息</p>}
        {messages.map((m) => (
          <div key={m.index} className={`bubble ${String(m.role)}`}>
            <span className="role">{String(m.role)}</span>
            <div className="content">{renderContent(m)}</div>
          </div>
        ))}
        {running && <div className="running">agent 正在运行…</div>}
        <div ref={bottomRef} />
      </div>

      {view?.approvals.map((a) => (
        <div key={a.requestId} className="approval">
          <span>{String(a.title ?? a.toolName ?? '需要审批')}</span>
          <div className="actions">
            <button
              type="button"
              className="btn sm"
              onClick={() => props.onApproval(a.requestId, 'deny')}
            >
              拒绝
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => props.onApproval(a.requestId, 'allowSession')}
            >
              本会话允许
            </button>
            <button
              type="button"
              className="btn primary sm"
              onClick={() => props.onApproval(a.requestId, 'allow')}
            >
              允许
            </button>
          </div>
        </div>
      ))}

      {view?.asks.map((a) => (
        <AskBar key={a.requestId} ask={a} onAnswer={props.onAsk} />
      ))}

      {error && <p className="error">{error}</p>}

      <div className="composer">
        {images.length > 0 && (
          <div className="thumbs">
            {images.map(({ id, image }) => (
              <div key={id} className="thumb">
                <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
                <button
                  type="button"
                  onClick={() => setImages((prev) => prev.filter((item) => item.id !== id))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="input-row">
          <label className="attach">
            +
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => void pickImages(e.target.files)}
            />
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={running ? '插话（steer）…' : '发消息…'}
            rows={1}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {running ? (
            <button type="button" className="btn stop" onClick={props.onAbort}>
              停
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={submit}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AskBar({
  ask,
  onAnswer,
}: {
  ask: { requestId: string; [key: string]: unknown };
  onAnswer(requestId: string, answer: string): void;
}) {
  const [value, setValue] = useState('');
  return (
    <div className="approval">
      <span>{String(ask.question ?? '需要回答')}</span>
      <div className="actions">
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="回答…" />
        <button
          type="button"
          className="btn primary sm"
          onClick={() => {
            onAnswer(ask.requestId, value);
            setValue('');
          }}
        >
          回答
        </button>
      </div>
    </div>
  );
}

/** 消息投影结构与桌面一致，这里只做纯文本降级渲染 */
function renderContent(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const p = part as Record<string, unknown>;
        if (typeof p.text === 'string') return p.text;
        if (p.type === 'image') return '[图片]';
        if (typeof p.toolName === 'string') return `[工具 ${p.toolName}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof message.text === 'string') return message.text;
  return '';
}
