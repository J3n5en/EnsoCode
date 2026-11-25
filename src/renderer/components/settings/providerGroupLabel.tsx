import { useI18n } from '@/i18n';

/** 模型中心服务商分组标题：条目计数跟在名字后面，不再是标题下面孤零零一行数字 */
export function ProviderGroupLabel({ label, count }: { label: string; count: number }) {
  const { t } = useI18n();
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate">{label}</span>
      <span className="shrink-0 font-normal text-[11px] text-muted-foreground">
        {t('{{count}} providers', { count })}
      </span>
    </span>
  );
}
