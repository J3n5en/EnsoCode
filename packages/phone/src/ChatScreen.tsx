import type { AttachedImage, ProjectedMessage } from '@shared/types/agent';
import { PanelLeft, SquarePen } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { ApprovalBar } from '@/components/chat/ApprovalBar';
import { AskBar } from '@/components/chat/AskBar';
import { Composer } from '@/components/chat/Composer';
import {
  CHAT_COL,
  MessageTimeline,
  type MessageTimelineHandle,
} from '@/components/chat/MessageTimeline';
import { buildTimeline } from '@/stores/sessions/timeline';
import type { ConnState, SessionView } from './client';
import { compressImage } from './image';
import { setDisplayedConversation } from './stubs/sessions-store';

interface Props {
  sessionId: string | null;
  title: string;
  projectName: string;
  view: SessionView | null;
  connState: ConnState;
  stateLabel: string;
  canCreate: boolean;
  onOpenDrawer(): void;
  onNewSession(): void;
  onSend(text: string, images: AttachedImage[]): void;
  onAbort(): void;
  onApproval(requestId: string, decision: 'allow' | 'allowSession' | 'deny'): void;
  onAsk(requestId: string, answer: string): void;
}

/** 会话页：复用桌面的时间线 / 审批条 / 输入框，保持与桌面一致的渲染 */
export function ChatScreen(props: Props) {
  const { view, sessionId } = props;
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
  setDisplayedConversation(
    sessionId
      ? {
          id: sessionId,
          status: view?.status ?? 'idle',
          started: false,
          spawning: false,
          messages,
        }
      : null
  );

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
      <header className="flex shrink-0 items-center gap-1 border-b px-2 py-2 pt-safe">
        <button
          type="button"
          onClick={props.onOpenDrawer}
          aria-label="打开会话列表"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelLeft className="h-4.5 w-4.5" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate font-medium text-sm">{props.title}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {props.projectName || props.stateLabel}
          </p>
        </div>
        <button
          type="button"
          onClick={props.onNewSession}
          disabled={!props.canCreate}
          aria-label="新建会话"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <SquarePen className="h-4.5 w-4.5" />
        </button>
      </header>

      {sessionId === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <p className="font-medium text-lg">EnsoCode</p>
          <p className="text-muted-foreground text-sm">
            {props.connState === 'online' ? '从左上角选择会话，或新建一个' : props.stateLabel}
          </p>
        </div>
      ) : (
        <MessageTimeline
          key={sessionId}
          ref={timelineRef}
          items={timeline}
          // view 为 null = 快照尚未到达，交给时间线显示加载态而非空态
          busy={running || view === null}
          running={running}
          error={undefined}
          emptyTitle={props.projectName || 'EnsoCode'}
        />
      )}

      {sessionId !== null && (
        // 浏览器里 safe-area 为 0，用 0.5rem 兜底不贴边；standalone 下取
        // home indicator 的实际高度，不再叠加，避免下方留出多余空白
        <div className="@container shrink-0 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <div className={CHAT_COL}>
            <ApprovalBar approvals={view?.approvals ?? []} onRespond={props.onApproval} />
            <AskBar asks={view?.asks ?? []} onAnswer={props.onAsk} />
            <Composer
              commands={[]}
              running={running}
              busy={running}
              locked={(view?.approvals ?? []).length > 0}
              focusKey={sessionId}
              // 移动端不自动聚焦：一进会话就弹键盘会挡住消息
              autoFocus={false}
              onSend={(text, images) => void send(text, images)}
              onAbort={props.onAbort}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Composer 已把图片读成 base64，这里只在超限时再压一轮 */
async function compressImageIfNeeded(image: AttachedImage): Promise<AttachedImage> {
  if (image.data.length * 0.75 <= 700_000) return image;
  const blob = await (await fetch(`data:${image.mimeType};base64,${image.data}`)).blob();
  return compressImage(new File([blob], 'image', { type: image.mimeType }));
}
