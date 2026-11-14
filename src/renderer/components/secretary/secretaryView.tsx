import type { SecretaryState } from '@shared/types/secretary';
import { useI18n } from '@/i18n';

export interface SecretarySectionView {
  name: string;
  /** 「需要你处理」总数，折叠侧栏时也带着 */
  needsYou: number;
  running: number;
  /** false = 未完成初次设置，点击进欢迎页 */
  configured: boolean;
  color?: string;
}

/** 秘书伪项目的展示状态；开关关掉时整块不出现 */
export function secretarySectionView(
  secretary: Pick<SecretaryState, 'enabled' | 'profile' | 'board'>,
  t: (key: string) => string
): SecretarySectionView | null {
  if (!secretary.enabled) return null;
  const profile = secretary.profile;
  return {
    name: profile?.name.trim() || t('Secretary'),
    needsYou: secretary.board.needsYou.length,
    running: secretary.board.running.length,
    configured: profile !== null,
    ...(profile ? { color: profile.avatar.color } : {}),
  };
}

/** 一行摘要：等你的那份用警告色强调，都在闲时说一句没有在跑的活 */
export function SecretarySummary({ view }: { view: SecretarySectionView }) {
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
      {view.running > 0 && (
        <span className="shrink-0">{t('{{n}} running', { n: view.running })}</span>
      )}
    </>
  );
}
