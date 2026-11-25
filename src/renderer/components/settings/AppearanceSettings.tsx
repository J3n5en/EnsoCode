import { ACCENT_PRESETS } from '@shared/accentColor';
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '@shared/localImage';
import { resolveTheme } from '@shared/theme/themeKey';
import {
  FileCode,
  FolderOpen,
  ImageIcon,
  Monitor,
  Moon,
  RefreshCw,
  Sun,
  Terminal,
} from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { addToast } from '@/components/ui/toast';
import { useEffectiveBackground } from '@/hooks/useBackgroundImage';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useI18n } from '@/i18n';
import { availableThemes } from '@/lib/themeStyles';
import { cn } from '@/lib/utils';
import { usePluginThemesStore } from '@/stores/pluginThemes';
import {
  ACCENT_COLORS,
  type AccentColor,
  type BackgroundSizeMode,
  type BackgroundSourceType,
  type Theme,
  useSettingsStore,
} from '@/stores/settings';
import {
  SettingsButton,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from './kit';
import { ThemeGallery } from './ThemeGallery';

const ACCENT_LABELS = {
  theme: 'Follow theme',
  violet: 'Violet',
  indigo: 'Indigo',
  teal: 'Teal',
  amber: 'Amber',
  graphite: 'Graphite',
} as const satisfies Record<AccentColor, string>;

function DraftSlider({
  label,
  value,
  onCommit,
  min = 0,
  max = 100,
  step,
  unit = '%',
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => {
    setLocal(value);
  }, [value]);
  return (
    <SettingsRow label={label}>
      <div className="w-[140px] sm:w-[180px]">
        <Slider
          min={min}
          max={max}
          step={step}
          value={local}
          onValueChange={(next) => setLocal(Array.isArray(next) ? next[0] : next)}
          onValueCommitted={(next) => onCommit(Array.isArray(next) ? next[0] : next)}
        />
      </div>
      <span className="shrink-0 text-right text-[12px] text-muted-foreground tabular-nums">
        {local}
        {unit}
      </span>
    </SettingsRow>
  );
}

function BackgroundImageSettings() {
  const { t } = useI18n();
  const enabled = useSettingsStore((s) => s.backgroundImageEnabled);
  const setEnabled = useSettingsStore((s) => s.setBackgroundImageEnabled);
  const sourceType = useSettingsStore((s) => s.backgroundSourceType);
  const setSourceType = useSettingsStore((s) => s.setBackgroundSourceType);
  const imagePath = useSettingsStore((s) => s.backgroundImagePath);
  const setImagePath = useSettingsStore((s) => s.setBackgroundImagePath);
  const folderPath = useSettingsStore((s) => s.backgroundFolderPath);
  const setFolderPath = useSettingsStore((s) => s.setBackgroundFolderPath);
  const urlPath = useSettingsStore((s) => s.backgroundUrlPath);
  const setUrlPath = useSettingsStore((s) => s.setBackgroundUrlPath);
  const randomEnabled = useSettingsStore((s) => s.backgroundRandomEnabled);
  const setRandomEnabled = useSettingsStore((s) => s.setBackgroundRandomEnabled);
  const randomInterval = useSettingsStore((s) => s.backgroundRandomInterval);
  const setRandomInterval = useSettingsStore((s) => s.setBackgroundRandomInterval);
  const opacity = useSettingsStore((s) => s.backgroundOpacity);
  const setOpacity = useSettingsStore((s) => s.setBackgroundOpacity);
  const blur = useSettingsStore((s) => s.backgroundBlur);
  const setBlur = useSettingsStore((s) => s.setBackgroundBlur);
  const brightness = useSettingsStore((s) => s.backgroundBrightness);
  const setBrightness = useSettingsStore((s) => s.setBackgroundBrightness);
  const saturation = useSettingsStore((s) => s.backgroundSaturation);
  const setSaturation = useSettingsStore((s) => s.setBackgroundSaturation);
  const mask = useSettingsStore((s) => s.backgroundMask);
  const setMask = useSettingsStore((s) => s.setBackgroundMask);
  const composerOpacity = useSettingsStore((s) => s.backgroundComposerOpacity);
  const setComposerOpacity = useSettingsStore((s) => s.setBackgroundComposerOpacity);
  const codeOpacity = useSettingsStore((s) => s.backgroundCodeOpacity);
  const setCodeOpacity = useSettingsStore((s) => s.setBackgroundCodeOpacity);
  const sizeMode = useSettingsStore((s) => s.backgroundSizeMode);
  const setSizeMode = useSettingsStore((s) => s.setBackgroundSizeMode);
  const bumpRefresh = useSettingsStore((s) => s.bumpBackgroundRefresh);
  const themeBackground = useEffectiveBackground()?.source === 'theme';

  const storedPath =
    sourceType === 'file' ? imagePath : sourceType === 'folder' ? folderPath : urlPath;
  const [localPath, setLocalPath] = React.useState(storedPath);
  React.useEffect(() => {
    setLocalPath(storedPath);
  }, [storedPath]);

  const commitPath = React.useCallback(() => {
    const value = localPath.trim();
    if (sourceType === 'file') setImagePath(value);
    else if (sourceType === 'folder') setFolderPath(value);
    else setUrlPath(value);
  }, [localPath, sourceType, setImagePath, setFolderPath, setUrlPath]);

  const [localInterval, setLocalInterval] = React.useState(randomInterval);
  React.useEffect(() => {
    setLocalInterval(randomInterval);
  }, [randomInterval]);

  const browse = async () => {
    if (sourceType === 'folder') {
      const dir = await window.electronAPI.dialog.selectDirectory();
      if (dir) setFolderPath(dir);
    } else {
      const file = await window.electronAPI.dialog.selectFile([
        ...IMAGE_EXTENSIONS,
        ...VIDEO_EXTENSIONS,
      ]);
      if (file) setImagePath(file);
    }
  };

  const sourceTypeOptions: { value: BackgroundSourceType; label: string }[] = [
    { value: 'file', label: t('Single image') },
    { value: 'folder', label: t('Folder (random)') },
    { value: 'url', label: t('Remote URL') },
  ];
  const sizeModeOptions: { value: BackgroundSizeMode; label: string }[] = [
    { value: 'cover', label: t('Cover') },
    { value: 'contain', label: t('Contain') },
    { value: 'repeat', label: t('Repeat') },
    { value: 'center', label: t('Center') },
  ];
  const pathLabel =
    sourceType === 'file'
      ? t('Image path')
      : sourceType === 'folder'
        ? t('Folder path')
        : t('Image URL');

  return (
    <SettingsSection
      rowId="appearance.background-image"
      title={t('Background image')}
      description={t('Show a custom image behind the interface')}
      actions={
        <SettingsSwitch
          checked={enabled}
          onCheckedChange={(checked) => setEnabled(checked === true)}
        />
      }
    >
      {themeBackground && (
        <p className="py-2 text-[12px] text-muted-foreground">
          {t(
            'The current theme has its own background. Turn this on to replace it with your image.'
          )}
        </p>
      )}
      {enabled && (
        <>
          <SettingsRow rowId="appearance.source-type" label={t('Source type')}>
            <SettingsSelect
              value={sourceType}
              options={sourceTypeOptions}
              onValueChange={setSourceType}
            />
          </SettingsRow>
          <SettingsRow label={pathLabel}>
            <Input
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              onBlur={commitPath}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') {
                  commitPath();
                  e.currentTarget.blur();
                }
              }}
              placeholder={sourceType === 'url' ? 'https://example.com/image.jpg' : ''}
              className="w-[min(100%,220px)] max-w-full"
            />
            {sourceType !== 'url' && (
              <Button variant="outline" size="icon" onClick={browse} aria-label={t('Browse')}>
                {sourceType === 'folder' ? (
                  <FolderOpen className="h-4 w-4" />
                ) : (
                  <ImageIcon className="h-4 w-4" />
                )}
              </Button>
            )}
            {sourceType !== 'file' && (
              <Button
                variant="outline"
                size="icon"
                onClick={bumpRefresh}
                aria-label={t('Refresh now')}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            )}
          </SettingsRow>
          {sourceType !== 'file' && (
            <SettingsRow rowId="appearance.auto-switch" label={t('Auto switch')}>
              <SettingsSwitch
                checked={randomEnabled}
                onCheckedChange={(checked) => setRandomEnabled(checked === true)}
              />
              {randomEnabled && (
                <>
                  <Input
                    type="number"
                    min={5}
                    max={86400}
                    value={localInterval}
                    onChange={(e) => setLocalInterval(Number(e.target.value))}
                    onBlur={() => setRandomInterval(localInterval)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setRandomInterval(localInterval);
                        e.currentTarget.blur();
                      }
                    }}
                    className="w-24 max-w-full"
                  />
                  <span className="text-[12px] text-muted-foreground">{t('seconds')}</span>
                </>
              )}
            </SettingsRow>
          )}
          <DraftSlider
            label={t('Background visibility')}
            value={Math.round(opacity * 100)}
            onCommit={(v) => setOpacity(v / 100)}
          />
          <DraftSlider label={t('Blur')} value={blur} onCommit={setBlur} max={20} unit="px" />
          <DraftSlider
            label={t('Brightness')}
            value={Math.round(brightness * 100)}
            onCommit={(v) => setBrightness(v / 100)}
            max={200}
          />
          <DraftSlider
            label={t('Saturation')}
            value={Math.round(saturation * 100)}
            onCommit={(v) => setSaturation(v / 100)}
            max={200}
          />
          <DraftSlider
            label={t('Overlay')}
            value={Math.round(mask * 100)}
            onCommit={(v) => setMask(v / 100)}
          />
          <DraftSlider
            label={t('Composer opacity')}
            value={Math.round(composerOpacity * 100)}
            onCommit={(v) => setComposerOpacity(v / 100)}
          />
          <DraftSlider
            label={t('Code block opacity')}
            value={Math.round(codeOpacity * 100)}
            onCommit={(v) => setCodeOpacity(v / 100)}
          />
          <SettingsRow rowId="appearance.size-mode" label={t('Size mode')}>
            <SettingsSelect
              value={sizeMode}
              options={sizeModeOptions}
              onValueChange={setSizeMode}
            />
          </SettingsRow>
        </>
      )}
    </SettingsSection>
  );
}

function UserCssRow() {
  const { t } = useI18n();
  const enabled = useSettingsStore((s) => s.userCssEnabled);
  const setEnabled = useSettingsStore((s) => s.setUserCssEnabled);
  const open = async () => {
    const result = await window.electronAPI.appearance.openUserCss();
    if (!result.ok)
      addToast({ type: 'error', title: t('Cannot open user.css'), description: result.error });
  };
  return (
    <SettingsSection>
      <SettingsRow
        rowId="appearance.userCss"
        label={t('Custom CSS')}
        description={t('Inject user.css into every window; saved changes apply immediately')}
      >
        <SettingsButton onClick={() => void open()}>
          <FileCode />
          {t('Open user.css')}
        </SettingsButton>
        <SettingsSwitch
          checked={enabled}
          onCheckedChange={(checked) => setEnabled(checked === true)}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

export function AppearanceSettings({ onOpenPlugins }: { onOpenPlugins?: () => void } = {}) {
  const { t } = useI18n();
  const borderOpacity = useSettingsStore((s) => s.borderOpacity);
  const setBorderOpacity = useSettingsStore((s) => s.setBorderOpacity);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const themeId = useSettingsStore((s) => s.themeId);
  const setThemeId = useSettingsStore((s) => s.setThemeId);
  const accentColor = useSettingsStore((s) => s.accentColor);
  const setAccentColor = useSettingsStore((s) => s.setAccentColor);
  const navRailSide = useSettingsStore((s) => s.navRailSide);
  const setNavRailSide = useSettingsStore((s) => s.setNavRailSide);
  const pluginThemes = usePluginThemesStore((s) => s.themes);
  const colorScheme = useColorScheme();

  const themeModeOptions: { value: Theme; icon: React.ElementType; label: string }[] = [
    { value: 'light', icon: Sun, label: t('Light') },
    { value: 'dark', icon: Moon, label: t('Dark') },
    { value: 'system', icon: Monitor, label: t('System') },
    { value: 'sync-terminal', icon: Terminal, label: t('Sync terminal theme') },
  ];
  const accentOptions = ACCENT_COLORS.map((value) => ({
    value,
    label: t(ACCENT_LABELS[value]),
    swatch:
      value === 'theme'
        ? resolveTheme(themeId, availableThemes(pluginThemes))[colorScheme].accent
        : ACCENT_PRESETS[value][colorScheme],
  }));
  const railOptions: { value: 'left' | 'right' | 'off'; label: string }[] = [
    { value: 'left', label: t('Left') },
    { value: 'right', label: t('Right') },
    { value: 'off', label: t('Off') },
  ];

  return (
    <SettingsPage rowId="appearance.root" title={t('Appearance')}>
      <SettingsSection
        rowId="appearance.personalization"
        title={t('Personalization')}
        description={t('Applied on top of any theme')}
      >
        <SettingsRow rowId="appearance.theme" label={t('Theme mode')}>
          <div className="flex max-w-full flex-wrap rounded-lg bg-muted p-0.5">
            {themeModeOptions.map((option) => (
              <button
                type="button"
                key={option.value}
                onClick={() => setTheme(option.value)}
                aria-pressed={theme === option.value}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors',
                  theme === option.value
                    ? 'bg-background text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <option.icon className="size-3.5" />
                {option.label}
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          rowId="appearance.accent"
          label={t('Accent color')}
          description={t('Used for running state, checkmarks and plan mode')}
        >
          <div className="flex max-w-full flex-wrap items-center justify-end gap-2 pointer-coarse:gap-[26px]">
            {accentOptions.map((option) =>
              option.value === 'theme' ? (
                <button
                  type="button"
                  key={option.value}
                  onClick={() => setAccentColor(option.value)}
                  aria-pressed={accentColor === option.value}
                  className={cn(
                    'flex h-6 items-center gap-1.5 px-2 text-xs transition-shadow',
                    'rounded-full',
                    'border',
                    accentColor === option.value && 'border-transparent ring-2 ring-foreground/60'
                  )}
                >
                  <span
                    data-theme-accent
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: option.swatch }}
                  />
                  {option.label}
                </button>
              ) : (
                <button
                  type="button"
                  key={option.value}
                  onClick={() => setAccentColor(option.value)}
                  title={option.label}
                  aria-label={option.label}
                  aria-pressed={accentColor === option.value}
                  style={{ backgroundColor: option.swatch }}
                  className={cn(
                    'size-5 rounded-full transition-shadow',
                    accentColor === option.value &&
                      'ring-2 ring-offset-2 ring-offset-background ring-foreground/60'
                  )}
                />
              )
            )}
          </div>
        </SettingsRow>
        <SettingsRow
          rowId="appearance.navRailSide"
          label={t('Turn marks')}
          description={t(
            'Marks along the conversation for each turn. Hover to preview, click to jump. Hidden when the chat uses the full width.'
          )}
        >
          <div className="flex w-full max-w-36 rounded-lg bg-muted p-0.5 text-xs pointer-coarse:max-w-none">
            {railOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setNavRailSide(option.value)}
                aria-pressed={navRailSide === option.value}
                className={cn(
                  'flex-1 rounded-md px-2 py-1 transition-colors pointer-coarse:min-w-[44px]',
                  navRailSide === option.value
                    ? 'bg-background font-medium text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </SettingsRow>
        <DraftSlider
          label={t('Border opacity')}
          value={Math.round(borderOpacity * 100)}
          onCommit={(v) => setBorderOpacity(v / 100)}
        />
      </SettingsSection>

      <SettingsSection
        rowId="appearance.themeGallery"
        title={t('Theme')}
        description={t('Built-in and plugin themes; each one is a set of color tokens')}
      >
        <div className="py-3">
          <ThemeGallery
            themes={availableThemes(pluginThemes)}
            selected={themeId}
            mode={colorScheme}
            onSelect={setThemeId}
            onGetMore={onOpenPlugins}
          />
        </div>
      </SettingsSection>

      <UserCssRow />
      <BackgroundImageSettings />
    </SettingsPage>
  );
}
