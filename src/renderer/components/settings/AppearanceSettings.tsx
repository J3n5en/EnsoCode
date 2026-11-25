import { ACCENT_PRESETS } from '@shared/accentColor';
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '@shared/localImage';
import { resolveTheme } from '@shared/theme/themeKey';
import { AnimatePresence, MotionGlobalConfig, motion, useReducedMotion } from 'framer-motion';
import {
  FileCode,
  FolderOpen,
  ImageIcon,
  Monitor,
  Moon,
  RefreshCw,
  RotateCcw,
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
import { heightVariants } from '@/lib/motion';
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
  SettingsSegmented,
  SettingsSelect,
  SettingsStepper,
  SettingsSwitch,
  useSettingsRow,
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

function DraftSliderControls({
  local,
  setLocal,
  value,
  onCommit,
  min,
  max,
  step,
  unit,
  defaultValue,
}: {
  local: number;
  setLocal: (value: number) => void;
  value: number;
  onCommit: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit: string;
  defaultValue?: number;
}) {
  const { t } = useI18n();
  const row = useSettingsRow();
  return (
    <>
      {defaultValue !== undefined && local !== defaultValue && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t('Reset to default')}
          title={t('Reset to default')}
          className="text-muted-foreground hover:text-foreground"
          onClick={() => {
            setLocal(defaultValue);
            onCommit(defaultValue);
            row?.markSaved();
          }}
        >
          <RotateCcw className="size-3.5" />
        </Button>
      )}
      <div className="w-[140px] sm:w-[180px]">
        <Slider
          min={min}
          max={max}
          step={step}
          value={local}
          onValueChange={(next) => setLocal(Array.isArray(next) ? next[0] : next)}
          onValueCommitted={(next) => {
            const committed = Array.isArray(next) ? next[0] : next;
            if (committed !== value) {
              onCommit(committed);
              row?.markSaved();
            }
          }}
        />
      </div>
      <span className="shrink-0 text-right text-[12px] text-muted-foreground tabular-nums">
        {local}
        {unit}
      </span>
    </>
  );
}

function DraftSlider({
  label,
  value,
  onCommit,
  min = 0,
  max = 100,
  step,
  unit = '%',
  defaultValue,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  defaultValue?: number;
}) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => {
    setLocal(value);
  }, [value]);
  return (
    <SettingsRow label={label}>
      <DraftSliderControls
        local={local}
        setLocal={setLocal}
        value={value}
        onCommit={onCommit}
        min={min}
        max={max}
        step={step}
        unit={unit}
        defaultValue={defaultValue}
      />
    </SettingsRow>
  );
}

function BackgroundPathControls({
  localPath,
  setLocalPath,
  commitPath,
  sourceType,
  browse,
  bumpRefresh,
}: {
  localPath: string;
  setLocalPath: (value: string) => void;
  commitPath: () => boolean;
  sourceType: BackgroundSourceType;
  browse: () => Promise<void>;
  bumpRefresh: () => void;
}) {
  const { t } = useI18n();
  const row = useSettingsRow();
  const commit = () => {
    if (commitPath()) row?.markSaved();
  };
  return (
    <>
      <Input
        value={localPath}
        onChange={(e) => setLocalPath(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            commit();
            e.currentTarget.blur();
          }
        }}
        placeholder={sourceType === 'url' ? 'https://example.com/image.jpg' : ''}
        className="w-[min(100%,220px)] max-w-full"
      />
      {sourceType !== 'url' && (
        <Button
          variant="outline"
          size="icon"
          onClick={() => void browse()}
          aria-label={t('Browse')}
        >
          {sourceType === 'folder' ? (
            <FolderOpen className="h-4 w-4" />
          ) : (
            <ImageIcon className="h-4 w-4" />
          )}
        </Button>
      )}
      {sourceType !== 'file' && (
        <Button variant="outline" size="icon" onClick={bumpRefresh} aria-label={t('Refresh now')}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      )}
    </>
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

  const commitPath = React.useCallback((): boolean => {
    const value = localPath.trim();
    if (value === storedPath) return false;
    if (sourceType === 'file') setImagePath(value);
    else if (sourceType === 'folder') setFolderPath(value);
    else setUrlPath(value);
    return true;
  }, [localPath, storedPath, sourceType, setImagePath, setFolderPath, setUrlPath]);

  const reducedMotion = useReducedMotion();
  const reduced = reducedMotion === true || MotionGlobalConfig.skipAnimations === true;

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

  const controls = (
    <>
      <SettingsRow rowId="appearance.source-type" label={t('Source type')}>
        <SettingsSelect
          value={sourceType}
          options={sourceTypeOptions}
          onValueChange={setSourceType}
        />
      </SettingsRow>
      <SettingsRow label={pathLabel}>
        <BackgroundPathControls
          localPath={localPath}
          setLocalPath={setLocalPath}
          commitPath={commitPath}
          sourceType={sourceType}
          browse={browse}
          bumpRefresh={bumpRefresh}
        />
      </SettingsRow>
      {sourceType !== 'file' && (
        <SettingsRow rowId="appearance.auto-switch" label={t('Auto switch')}>
          <SettingsSwitch
            checked={randomEnabled}
            onCheckedChange={(checked) => setRandomEnabled(checked === true)}
          />
          {randomEnabled && (
            <>
              <SettingsStepper
                min={5}
                max={86400}
                value={randomInterval}
                onValueChange={setRandomInterval}
              />
              <span className="text-[12px] text-muted-foreground">{t('seconds')}</span>
            </>
          )}
        </SettingsRow>
      )}
      <DraftSlider
        label={t('Background visibility')}
        value={Math.round(opacity * 100)}
        defaultValue={85}
        onCommit={(v) => setOpacity(v / 100)}
      />
      <DraftSlider
        label={t('Blur')}
        value={blur}
        defaultValue={0}
        onCommit={setBlur}
        max={20}
        unit="px"
      />
      <DraftSlider
        label={t('Brightness')}
        value={Math.round(brightness * 100)}
        defaultValue={100}
        onCommit={(v) => setBrightness(v / 100)}
        max={200}
      />
      <DraftSlider
        label={t('Saturation')}
        value={Math.round(saturation * 100)}
        defaultValue={100}
        onCommit={(v) => setSaturation(v / 100)}
        max={200}
      />
      <DraftSlider
        label={t('Overlay')}
        value={Math.round(mask * 100)}
        defaultValue={50}
        onCommit={(v) => setMask(v / 100)}
      />
      <DraftSlider
        label={t('Composer opacity')}
        value={Math.round(composerOpacity * 100)}
        defaultValue={60}
        onCommit={(v) => setComposerOpacity(v / 100)}
      />
      <DraftSlider
        label={t('Code block opacity')}
        value={Math.round(codeOpacity * 100)}
        defaultValue={65}
        onCommit={(v) => setCodeOpacity(v / 100)}
      />
      <SettingsRow rowId="appearance.size-mode" label={t('Size mode')}>
        <SettingsSelect value={sizeMode} options={sizeModeOptions} onValueChange={setSizeMode} />
      </SettingsRow>
    </>
  );

  return (
    <SettingsSection
      rowId="appearance.background-image"
      title={t('Background image')}
      description={t('Show a custom image behind the interface')}
    >
      <SettingsRow
        rowId="appearance.enable-custom-background"
        label={t('Enable custom background image')}
        description={
          themeBackground
            ? t(
                'The current theme has its own background. Turn this on to replace it with your image.'
              )
            : undefined
        }
      >
        <SettingsSwitch
          checked={enabled}
          onCheckedChange={(checked) => setEnabled(checked === true)}
        />
      </SettingsRow>
      {reduced ? (
        enabled ? (
          controls
        ) : null
      ) : (
        <AnimatePresence initial={false}>
          {enabled && (
            <motion.div
              initial="initial"
              animate="animate"
              exit="exit"
              variants={heightVariants}
              className="overflow-hidden"
            >
              {controls}
            </motion.div>
          )}
        </AnimatePresence>
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
  const pluginThemes = usePluginThemesStore((s) => s.themes);
  const colorScheme = useColorScheme();
  const interfaceFontSize = useSettingsStore((s) => s.terminalFontSize);
  const setInterfaceFontSize = useSettingsStore((s) => s.setTerminalFontSize);
  const [localFontSize, setLocalFontSize] = React.useState(interfaceFontSize);
  const interfaceFontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const setInterfaceFontFamily = useSettingsStore((s) => s.setTerminalFontFamily);
  const [localFontFamily, setLocalFontFamily] = React.useState(interfaceFontFamily);

  React.useEffect(() => {
    setLocalFontSize(interfaceFontSize);
  }, [interfaceFontSize]);
  React.useEffect(() => {
    setLocalFontFamily(interfaceFontFamily);
  }, [interfaceFontFamily]);

  const applyFontSizeChange = React.useCallback(() => {
    const validFontSize = Math.max(8, Math.min(32, localFontSize || 8));
    if (validFontSize !== localFontSize) setLocalFontSize(validFontSize);
    if (validFontSize !== interfaceFontSize) setInterfaceFontSize(validFontSize);
  }, [localFontSize, interfaceFontSize, setInterfaceFontSize]);
  const applyFontFamilyChange = React.useCallback(() => {
    const validFontFamily = localFontFamily.trim() || interfaceFontFamily;
    if (validFontFamily !== localFontFamily) setLocalFontFamily(validFontFamily);
    if (validFontFamily !== interfaceFontFamily) setInterfaceFontFamily(validFontFamily);
  }, [localFontFamily, interfaceFontFamily, setInterfaceFontFamily]);

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
  return (
    <SettingsPage rowId="appearance.root" title={t('Appearance')}>
      <SettingsSection
        rowId="appearance.personalization"
        title={t('Personalization')}
        description={t('Applied on top of any theme')}
      >
        <SettingsRow rowId="appearance.theme" label={t('Theme mode')}>
          <SettingsSegmented value={theme} onValueChange={setTheme} options={themeModeOptions} />
        </SettingsRow>
        <SettingsRow
          rowId="terminal.font-size"
          label={t('Interface font size')}
          description={t(
            'Scales all interface text and command output in conversations; also the side panel terminal size. Conversation body text is set separately in Conversation display.'
          )}
        >
          <Input
            type="number"
            value={localFontSize}
            onChange={(e) => setLocalFontSize(Number(e.target.value))}
            onBlur={applyFontSizeChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                applyFontSizeChange();
                e.currentTarget.blur();
              }
            }}
            min={8}
            max={32}
            className="w-20 max-w-full"
          />
          <span className="text-[12px] text-muted-foreground">px</span>
        </SettingsRow>
        <SettingsRow
          rowId="terminal.font"
          label={t('Interface mono font')}
          description={t(
            'Monospace font for the side panel terminal, code blocks and command output in conversations.'
          )}
        >
          <Input
            value={localFontFamily}
            onChange={(e) => setLocalFontFamily(e.target.value)}
            onBlur={applyFontFamilyChange}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                applyFontFamilyChange();
                e.currentTarget.blur();
              }
            }}
            placeholder="JetBrains Mono, monospace"
            className="w-[min(100%,220px)] max-w-full"
          />
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
        <DraftSlider
          label={t('Border opacity')}
          value={Math.round(borderOpacity * 100)}
          defaultValue={100}
          onCommit={(v) => setBorderOpacity(v / 100)}
        />
      </SettingsSection>

      <SettingsSection
        bare
        rowId="appearance.themeGallery"
        title={t('Theme')}
        description={t('Built-in and plugin themes; each one is a set of color tokens')}
      >
        {theme === 'sync-terminal' && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-muted/60 px-4 py-2.5 text-[12px] text-muted-foreground">
            <span>
              {t(
                'Theme mode is set to Sync terminal theme, so interface colors follow your terminal theme instead of this gallery.'
              )}
            </span>
            <SettingsButton size="xs" onClick={() => setTheme('system')}>
              {t('Switch to System mode')}
            </SettingsButton>
          </div>
        )}
        <ThemeGallery
          themes={availableThemes(pluginThemes)}
          selected={themeId}
          mode={colorScheme}
          onSelect={setThemeId}
          onGetMore={onOpenPlugins}
        />
      </SettingsSection>

      <UserCssRow />
      <BackgroundImageSettings />
    </SettingsPage>
  );
}
