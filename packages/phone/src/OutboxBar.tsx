import { RotateCw, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OutboxItem } from './botOutbox';
import { rejectionText } from './readOnly';

interface Props {
  items: readonly OutboxItem[];
  /** 只读设备：重发也会被拦截，不给重试 */
  readOnly?: boolean;
  onRetry(deliveryId: string): void;
  onDiscard(deliveryId: string): void;
}

const STATUS_TEXT = { pending: '待发送', sending: '发送中…', failed: '发送失败' } as const;

/** Bot 聊天的离线待发队列：连上后按原 deliveryId 自动重发，失败的需手动重试 */
export function OutboxBar({ items, readOnly, onRetry, onDiscard }: Props) {
  if (items.length === 0) return null;
  return (
    <div className="mb-1 space-y-1">
      {items.map((item) => (
        <div
          key={item.deliveryId}
          className={cn(
            'flex flex-wrap items-center gap-2 rounded-xl border px-2.5 py-1.5 text-xs',
            item.status === 'failed' ? 'border-destructive/40 bg-destructive/5' : 'bg-muted/40'
          )}
        >
          <span
            className={cn(
              'min-w-0 flex-1',
              item.status === 'failed' ? 'whitespace-pre-wrap break-words select-text' : 'truncate'
            )}
          >
            {item.text || (item.images?.length ? `[${item.images.length} 张图片]` : '')}
          </span>
          <span
            className={cn(
              'min-w-0 break-words',
              item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {item.error?.startsWith('outbox-discard')
              ? '移除消息'
              : item.error === 'delivery-unconfirmed'
                ? '结果未确认'
                : STATUS_TEXT[item.status]}
            {item.status === 'failed' && item.error ? `：${rejectionText(item.error)}` : ''}
          </span>
          {item.status === 'failed' && !item.error?.startsWith('outbox-discard') && !readOnly && (
            <button
              type="button"
              aria-label="重试"
              onClick={() => onRetry(item.deliveryId)}
              className="shrink-0 rounded p-0.5 text-foreground hover:bg-accent"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          )}
          {item.status !== 'sending' && (
            <button
              type="button"
              aria-label="删除"
              disabled={item.error === 'outbox-discarding'}
              onClick={() => onDiscard(item.deliveryId)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
