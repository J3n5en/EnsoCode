import { Settings } from 'lucide-react';
import { TitleBar } from '@/components/app/TitleBar';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

export default function App() {
  const { t } = useI18n();

  return (
    <div className="flex h-screen flex-col">
      <TitleBar title="EnsoCode" />
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
        <h1 className="text-2xl font-semibold">EnsoCode</h1>
        <p className="text-sm text-muted-foreground">{t('Electron multi-window scaffold')}</p>
        <Button onClick={() => window.electronAPI.window.openSettings()}>
          <Settings className="h-4 w-4 mr-1.5" />
          {t('Settings')}
        </Button>
      </main>
    </div>
  );
}
