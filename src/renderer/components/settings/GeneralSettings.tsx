import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';

export function GeneralSettings() {
  const { language, setLanguage } = useSettingsStore();
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">{t('General')}</h3>
        <p className="text-sm text-muted-foreground">{t('General application settings')}</p>
      </div>

      <div className="grid grid-cols-[140px_1fr] items-center gap-4">
        <span className="text-sm font-medium">{t('Language')}</span>
        <Select value={language} onValueChange={(v) => setLanguage(v as 'en' | 'zh')}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="en">English</SelectItem>
            <SelectItem value="zh">简体中文</SelectItem>
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}
