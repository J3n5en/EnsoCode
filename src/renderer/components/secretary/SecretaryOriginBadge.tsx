import { useI18n } from '@/i18n';
import { useSecretaryName } from './useSecretaryFace';

/** 派出会话留在所属项目下，只加标记；任何权限判断都不读它 */
export function SecretaryOriginBadge() {
  const { t } = useI18n();
  const name = useSecretaryName();
  return (
    <span
      data-enso="secretary-origin"
      className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground group-hover:hidden"
    >
      {t('Dispatched by {{name}}', { name })}
    </span>
  );
}
