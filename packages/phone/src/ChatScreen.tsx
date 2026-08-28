import type { AttachedImage, ProjectedMessage } from '@shared/types/agent';
import { ChevronLeft } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { AskBar } from '@/components/chat/AskBar';
import { Composer } from '@/components/chat/Composer';
import {
  CHAT_COL,
  MessageTimeline,
  type MessageTimelineHandle,
} from '@/components/chat/MessageTimeline';
import { cn } from '@/lib/utils';
import { buildTimeline } from '@/stores/sessions/timeline';
import type { ConnState, SessionView } from './client';
import { compressImage } from './image';
import { setDisplayedConversation } from './stubs/sessions-store';

interface Props {
  sessionId: string;
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

/** 会话页：复用桌面的时间线 / 审批条 / 输入框，保持与桌面一致的渲染 */
export function ChatScreen(props: Props) {
  const { view } = props;
  const timelineRef = useRef<MessageTimelineHandle>(null);
  const running = view?.status === 'running';

  const messages = useMemo<ProjectedMessage[]>(
    () =>
      view
        ? [...view.messages.entries()].sort((a, b) => a[0] - b[0]).map(([, message]) => message)
        : [],
    [view]
  );

  // 供复用组件内部读取（RunningElapsed 的计时 key；回退在手机端不可用）
  setDisplayedConversation({
    id: props.sessionId,
    status: view?.status ?? 'idle',
    started: false,
    spawning: false,
    messages,
  });

  const timeline = useMemo(() => buildTimeline(messages, running), [messages, running]);

  const send = async (text: string, images: AttachedImage[]) => {
    // 手机拍照动辄数 MB，压到单帧上限内再发
    const compressed: AttachedImage[] = [];
    for (const image of images) {
      compressed.push(await compressImageIfNeeded(image));
    }
    props.onSend(text, compressed);
    timelineRef.current?.scrollToBottom();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-2 py-2 pt-safe">
        <button
          type="button"
          onClick={props.onBack}
          className="flex h-8 shrink-0 items-center rounded-md pr-2 pl-1 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          返回
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate font-medium text-sm">{props.title}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {props.projectName}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 px-1 text-[11px]',
            props.connState === 'online' ? 'text-success' : 'text-destructive'
          )}
        >
          {props.stateLabel}
        </span>
      </header>

      <MessageTimeline
        key={props.sessionId}
        ref={timelineRef}
        items={timeline}
        busy={running}
        running={running}
        error={undefined}
        emptyTitle={props.projectName || 'EnsoCode'}
      />

      <div className="@container shrink-0 pt-1 pb-safe">
        <div className={CHAT_COL}>
          <ApprovalBar approvals={view?.approvals ?? []} onRespond={props.onApproval} />
          <AskBar asks={view?.asks ?? []} onAnswer={props.onAsk} />
          <Composer
            commands={[]}
            running={running}
            busy={running}
            locked={(view?.approvals ?? []).length > 0}
            focusKey={props.sessionId}
            onSend={(text, images) => void send(text, images)}
            onAbort={props.onAbort}
          />
        </div>
      </div>
    </div>
  );
}

/** Composer 已把图片读成 base64，这里只在超限时再压一轮 */
async function compressImageIfNeeded(image: AttachedImage): Promise<AttachedImage> {
  if (image.data.length * 0.75 <= 700_000) return image;
  const blob = await (await fetch(`data:${image.mimeType};base64,${image.data}`)).blob();
  return compressImage(new File([blob], 'image', { type: image.mimeType }));
}
