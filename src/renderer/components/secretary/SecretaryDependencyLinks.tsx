import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { openSessionPeek } from '@/stores/sessionPeek';
import { useSessionsStore } from '@/stores/sessions';

/**
 * 依赖会话一行一个：有标题显示标题，点击就地打开会话弹窗；
 * 会话已删除或不在 store 时降级为 id 前 8 位，仍可点开（弹窗里会说明会话不存在）。
 */
export function DependencyLinks({
  ids,
  className,
}: {
  ids: readonly string[];
  className?: string;
}) {
  const conversations = useSessionsStore((state) => state.conversations);
  return (
    <>
      {ids.map((id) => {
        const conversation = conversations[id];
        const label = conversation?.title?.trim() || id.slice(0, 8);
        return (
          <button
            key={id}
            type="button"
            data-enso="secretary-dependency-link"
            data-conversation={id}
            title={conversation?.title?.trim() ? conversation.title : id}
            onClick={() => openSessionPeek(id)}
            className={cn(
              'block max-w-full truncate text-left underline decoration-dotted underline-offset-2',
              'transition-colors hover:text-foreground',
              className
            )}
          >
            {label}
          </button>
        );
      })}
    </>
  );
}

/**
 * 「等这些会话结束」之类的依赖说明：前缀走 i18n 模板，{{ids}} 插值换成逐条链接。
 * tNode 把 React 节点插进译文，中文冒号等标点仍由译文控制。
 */
export function DependencyNote({
  template,
  ids,
  className,
  dataEnso,
}: {
  /** 带 {{ids}} 占位的 i18n key，如 'After {{ids}}' */
  template: 'After {{ids}}' | 'Waited for {{ids}}';
  ids: readonly string[];
  className?: string;
  dataEnso?: string;
}) {
  const { tNode } = useI18n();
  return (
    <span data-enso={dataEnso} className={className}>
      {tNode(template, { ids: <DependencyLinks ids={ids} /> })}
    </span>
  );
}
