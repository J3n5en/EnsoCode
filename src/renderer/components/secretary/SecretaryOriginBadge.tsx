import { secretaryAvatarUrl } from '@shared/localImage';
import { secretaryOwner } from '@shared/secretary/origin';
import type { SecretaryProfile, SecretarySummary } from '@shared/types/secretary';
import { UserRound } from 'lucide-react';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { useSecretaryStore } from '@/stores/secretary';
import { SecretaryFace } from './SecretaryFace';

const DEFAULT_SECRETARY_ID = 'default';

/** 派出的会话默认静音：「派出 + 静音」不再挂铃铛，静音写进头像提示；分不出是谁设的静音，一律按这条走 */
export function showsMutedBell(muted: boolean, dispatched: boolean): boolean {
  return muted && !dispatched;
}

type OriginFace = Pick<SecretaryProfile, 'name' | 'avatar'> | SecretarySummary;

/**
 * 派出这个会话的秘书：会话行上记的 id，旧数据没有 id 就是 default。
 * 旧数据没有 id 时，按各秘书看板里的派发卡片认；清单还没到时按当前秘书认。
 * 清单里已经没有它就是被删了，返回 null。
 * selector 只取 store 里的原引用，避免每次新对象导致无限重渲染。
 */
function useOriginFace(
  secretaryId: string | undefined,
  conversationId: string | undefined
): OriginFace | null | undefined {
  return useSecretaryStore((state) => {
    const owner =
      secretaryId ??
      secretaryOwner(state.states, conversationId ?? '')?.secretaryId ??
      (state.secretaries.length === 0 || !conversationId
        ? (state.focusedId ?? DEFAULT_SECRETARY_ID)
        : null);
    if (!owner) return null;
    if (state.secretaries.length === 0) return state.secretary.profile ?? undefined;
    const summary = state.secretaries.find((entry) => entry.id === owner);
    if (!summary) return null;
    const owned = state.states[owner] ?? (state.focusedId === owner ? state.secretary : null);
    return owned?.profile ?? summary;
  });
}

/** 侧栏会话行：派出它的秘书的小头像，悬停写明谁派的、是否静音；任何权限判断都不读它 */
export function SecretaryOriginBadge({
  secretaryId = DEFAULT_SECRETARY_ID,
  conversationId,
  muted = false,
}: {
  secretaryId?: string;
  conversationId?: string;
  muted?: boolean;
}) {
  const { t } = useI18n();
  const face = useOriginFace(
    secretaryId === DEFAULT_SECRETARY_ID ? undefined : secretaryId,
    conversationId
  );
  const name = face?.name?.trim() || t('Secretary');
  const origin =
    face === null ? t('Dispatched by a deleted secretary') : t('Dispatched by {{name}}', { name });
  const label = muted ? t('{{label}} · muted', { label: origin }) : origin;
  const avatar = face?.avatar;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-enso="secretary-origin"
            data-secretary={secretaryId}
            data-deleted={face === null || undefined}
            role="img"
            aria-label={label}
            className="flex size-3.5 shrink-0 items-center justify-center"
          />
        }
      >
        {face === null ? (
          <span className="flex size-3.5 items-center justify-center rounded-[4px] bg-muted text-subtle-foreground">
            <UserRound className="size-2.5" aria-hidden />
          </span>
        ) : (
          <SecretaryFace
            name={name}
            color={avatar?.color}
            image={
              avatar?.imageVersion
                ? secretaryAvatarUrl(avatar.imageVersion, avatar.imageHash, secretaryId)
                : undefined
            }
            enso="secretary-origin-face"
            className="size-3.5 rounded-[4px] text-[8px]"
          />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
