import { secretaryAvatarUrl } from '@shared/localImage';
import type { SecretaryState } from '@shared/types/secretary';
import { useI18n } from '@/i18n';
import { type RunningOriginsLink, SecretaryRunningOriginsCard } from './SecretaryRunningOrigins';

export interface SecretarySectionView {
  name: string;
  /** 「需要你处理」总数，折叠侧栏时也带着 */
  needsYou: number;
  running: number;
  /** false = 未完成初次设置，点击进欢迎页 */
  configured: boolean;
  color?: string;
  /** 受控头像 URL；没有图片时缺省 */
  image?: string;
}

/** 秘书伪项目的展示状态；开关关掉时整块不出现 */
export function secretarySectionView(
  secretary: Pick<SecretaryState, 'enabled' | 'profile' | 'board' | 'secretaryId'>,
  t: (key: string) => string,
  secretaryId?: string
): SecretarySectionView | null {
  if (!secretary.enabled) return null;
  const profile = secretary.profile;
  const imageVersion = profile?.avatar.imageVersion;
  // 多秘书时头像地址要带所属秘书；没显式给就用这份状态自己的 id
  const owner = secretaryId ?? secretary.secretaryId ?? undefined;
  return {
    name: profile?.name.trim() || t('Secretary'),
    needsYou: secretary.board.needsYou.length,
    running: secretary.board.running.length,
    configured: profile !== null,
    ...(profile ? { color: profile.avatar.color } : {}),
    ...(imageVersion
      ? { image: secretaryAvatarUrl(imageVersion, profile?.avatar.imageHash, owner) }
      : {}),
  };
}

/**
 * 一行摘要：等你的那份用警告色强调，都在闲时说一句没有在跑的活。
 * 传了 onToggleRunning 时「进行中 N」是可点的展开开关（秘书面板），侧栏不传就只是文字。
 */
export function SecretarySummary({
  view,
  runningExpanded,
  onToggleRunning,
  origins,
}: {
  view: SecretarySectionView;
  runningExpanded?: boolean;
  onToggleRunning?: () => void;
  /** 侧栏传入：悬停「N 件在跑」看每件属于哪条会话 */
  origins?: RunningOriginsLink;
}) {
  const { t } = useI18n();
  if (!view.configured) return <>{t('Click to finish setup')}</>;
  if (view.needsYou === 0 && view.running === 0) return <>{t('Nothing running')}</>;
  return (
    <>
      {view.needsYou > 0 && (
        <span data-enso="secretary-badge" className="shrink-0 font-medium text-warning">
          {t('{{n}} waiting', { n: view.needsYou })}
        </span>
      )}
      {view.needsYou > 0 && view.running > 0 && ' · '}
      {view.running > 0 &&
        (onToggleRunning ? (
          <button
            type="button"
            data-enso="secretary-running-toggle"
            aria-expanded={runningExpanded ?? false}
            onClick={onToggleRunning}
            className="shrink-0 rounded px-0.5 transition-colors hover:text-foreground"
          >
            {t('{{n}} running', { n: view.running })}
          </button>
        ) : origins ? (
          <SecretaryRunningOriginsCard
            label={t('{{n}} running', { n: view.running })}
            {...origins}
          />
        ) : (
          <span className="shrink-0">{t('{{n}} running', { n: view.running })}</span>
        ))}
    </>
  );
}
