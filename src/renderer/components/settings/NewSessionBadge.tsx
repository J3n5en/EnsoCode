import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipPopup, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';

/** 标记只对新会话生效的设置；未标记的设置修改后立即生效。note 为已翻译的说明；缺省为通用说明 */
export function NewSessionBadge({ note }: { note?: string }) {
  const { t } = useI18n();
  const label = t('New sessions only');
  const description = `${
    note ?? t('Open sessions keep the previous setting; it applies once you start a new session.')
  } ${t('Settings without this tag take effect immediately.')}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            size="sm"
            className="ml-2 align-middle font-normal text-muted-foreground"
            aria-label={`${label}: ${description}`}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup className="max-w-72">{description}</TooltipPopup>
    </Tooltip>
  );
}
