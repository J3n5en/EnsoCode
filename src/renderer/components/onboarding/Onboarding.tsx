import { Check, Layers, Plug, Server, Sparkles, Wand2, X } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { LocalAssetImportDialog } from '../settings/LocalAssetImportDialog';
import { LocalImportDialog } from '../settings/LocalImportDialog';
import { PresetEditDialog } from '../settings/PresetsSettings';

type StepId = 'welcome' | 'provider' | 'skill' | 'mcp' | 'instruction' | 'preset' | 'done';
const STEPS: StepId[] = ['welcome', 'provider', 'skill', 'mcp', 'instruction', 'preset', 'done'];

/** 首次运行引导：欢迎 → 四类导入 → 完成；每步可跳过，随时可关闭 */
export function Onboarding() {
  const { t } = useI18n();
  const setOnboarded = useSettingsStore((s) => s.setOnboarded);
  const providers = useSettingsStore((s) => s.providers);
  const skills = useSettingsStore((s) => s.skills);
  const mcpServers = useSettingsStore((s) => s.mcpServers);
  const instructions = useSettingsStore((s) => s.instructions);
  const presets = useSettingsStore((s) => s.presets);

  const [stepIndex, setStepIndex] = React.useState(0);
  const [importKind, setImportKind] = React.useState<'skill' | 'mcp' | 'instruction' | null>(null);
  const [providerOpen, setProviderOpen] = React.useState(false);
  const [presetOpen, setPresetOpen] = React.useState(false);
  const step = STEPS[stepIndex];

  const finish = () => setOnboarded(true);
  const next = () => setStepIndex((i) => Math.min(STEPS.length - 1, i + 1));
  const prev = () => setStepIndex((i) => Math.max(0, i - 1));

  const importStep: Record<
    'provider' | 'skill' | 'mcp' | 'instruction',
    { icon: React.ElementType; title: string; desc: string; count: number; onImport: () => void }
  > = {
    provider: {
      icon: Server,
      title: t('Model Providers'),
      desc: t('Import model API providers from local AI apps to start chatting'),
      count: providers.length,
      onImport: () => setProviderOpen(true),
    },
    skill: {
      icon: Sparkles,
      title: t('Skills'),
      desc: t('Import skills from Claude Code, Codex or Cursor'),
      count: skills.length,
      onImport: () => setImportKind('skill'),
    },
    mcp: {
      icon: Plug,
      title: t('MCP Servers'),
      desc: t('Import MCP servers configured in local AI apps'),
      count: mcpServers.length,
      onImport: () => setImportKind('mcp'),
    },
    instruction: {
      icon: Layers,
      title: t('Instruction Files'),
      desc: t('Import global instruction files configured in local AI tools'),
      count: instructions.length,
      onImport: () => setImportKind('instruction'),
    },
  };

  return (
    <div className="fixed inset-0 z-[45] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="relative flex w-[32rem] max-w-[90vw] flex-col rounded-2xl border bg-popover p-6 shadow-xl">
        <button
          type="button"
          onClick={finish}
          className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t('Close')}
        >
          <X className="h-4 w-4" />
        </button>

        {/* 进度点 */}
        <div className="mb-5 flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                i <= stepIndex ? 'bg-primary' : 'bg-muted'
              )}
            />
          ))}
        </div>

        {step === 'welcome' && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Wand2 className="h-6 w-6 text-primary" />
            </div>
            <h2 className="text-lg font-semibold">{t('Welcome to EnsoCode')}</h2>
            <p className="text-sm text-muted-foreground">
              {t(
                'Import your providers and assets from local AI apps to get started. You can skip any step.'
              )}
            </p>
          </div>
        )}

        {step !== 'welcome' && step !== 'done' && step !== 'preset' && (
          <ImportStepView
            {...importStep[step]}
            importedLabel={t('{{count}} imported', { count: importStep[step].count })}
            importLabel={t('Scan and import')}
          />
        )}

        {step === 'preset' && (
          <ImportStepView
            icon={Layers}
            title={t('Presets')}
            desc={t('Bundle skills, MCP servers and an instruction file into a preset (optional)')}
            count={presets.length}
            onImport={() => setPresetOpen(true)}
            importedLabel={t('{{count}} presets', { count: presets.length })}
            importLabel={t('New preset')}
          />
        )}

        {step === 'done' && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Check className="h-6 w-6 text-primary" />
            </div>
            <h2 className="text-lg font-semibold">{t('All set')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('You can always import more from Settings later.')}
            </p>
          </div>
        )}

        {/* 导航 */}
        <div className="mt-6 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={prev} disabled={stepIndex === 0}>
            {t('Back')}
          </Button>
          <div className="flex items-center gap-2">
            {step !== 'done' && step !== 'welcome' && (
              <Button variant="ghost" size="sm" onClick={next}>
                {t('Skip')}
              </Button>
            )}
            {step === 'done' ? (
              <Button size="sm" onClick={finish}>
                {t('Done')}
              </Button>
            ) : (
              <Button size="sm" onClick={next}>
                {step === 'welcome' ? t('Get started') : t('Next')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* 复用现有导入弹窗（受控） */}
      <LocalImportDialog open={providerOpen} onOpenChange={setProviderOpen} />
      {importKind && (
        <LocalAssetImportDialog
          kind={importKind}
          open
          onOpenChange={(open) => !open && setImportKind(null)}
        />
      )}
      {presetOpen && <PresetEditDialog preset={null} onClose={() => setPresetOpen(false)} />}
    </div>
  );
}

function ImportStepView({
  icon: Icon,
  title,
  desc,
  count,
  onImport,
  importedLabel,
  importLabel,
}: {
  icon: React.ElementType;
  title: string;
  desc: string;
  count: number;
  onImport: () => void;
  importedLabel: string;
  importLabel: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{desc}</p>
      <Button variant="outline" size="sm" onClick={onImport} className="mt-1">
        {importLabel}
      </Button>
      {count > 0 && <p className="text-xs text-primary">{importedLabel}</p>}
    </div>
  );
}
