import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '@shared/localImage';
import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Heart,
  ImageIcon,
  Monitor,
  Moon,
  RefreshCw,
  Sun,
  Terminal,
} from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import {
  defaultDarkTheme,
  getThemeNames,
  getXtermTheme,
  type XtermTheme,
} from '@/lib/ghosttyTheme';
import { cn } from '@/lib/utils';
import {
  type BackgroundSizeMode,
  type BackgroundSourceType,
  type FontWeight,
  type Theme,
  useSettingsStore,
} from '@/stores/settings';
import { fontWeightOptions } from './constants';

/** 背景图设置区：百分比滑块行（拖动时本地预览，松手才写 store，避免拖动中频繁 IPC） */
function PercentSliderRow({
  label,
  value,
  onCommit,
  min = 0,
  max = 100,
  unit = '%',
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  unit?: string;
}) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => {
    setLocal(value);
  }, [value]);

  return (
    <div className="grid grid-cols-[100px_1fr] items-center gap-4">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-3">
        <Slider
          min={min}
          max={max}
          value={local}
          onValueChange={(v) => setLocal(Array.isArray(v) ? v[0] : v)}
          onValueCommitted={(v) => onCommit(Array.isArray(v) ? v[0] : v)}
        />
        <span className="w-12 shrink-0 text-right text-sm text-muted-foreground">
          {local}
          {unit}
        </span>
      </div>
    </div>
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
  const composerOpacity = useSettingsStore((s) => s.backgroundComposerOpacity);
  const setComposerOpacity = useSettingsStore((s) => s.setBackgroundComposerOpacity);
  const codeOpacity = useSettingsStore((s) => s.backgroundCodeOpacity);
  const setCodeOpacity = useSettingsStore((s) => s.setBackgroundCodeOpacity);
  const sizeMode = useSettingsStore((s) => s.backgroundSizeMode);
  const setSizeMode = useSettingsStore((s) => s.setBackgroundSizeMode);
  const bumpRefresh = useSettingsStore((s) => s.bumpBackgroundRefresh);

  // 路径类输入框：本地编辑，blur/Enter 时提交（与字体设置同一惯例）
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
    <>
      <div className="flex items-center justify-between border-t pt-6">
        <div>
          <h3 className="text-lg font-medium">{t('Background image')}</h3>
          <p className="text-sm text-muted-foreground">
            {t('Show a custom image behind the interface')}
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={(checked) => setEnabled(checked === true)} />
      </div>

      {enabled && (
        <>
          {/* Source type */}
          <div className="grid grid-cols-[100px_1fr] items-center gap-4">
            <span className="text-sm font-medium">{t('Source type')}</span>
            <Select
              items={sourceTypeOptions}
              value={sourceType}
              onValueChange={(v) => setSourceType(v as BackgroundSourceType)}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {sourceTypeOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>

          {/* Source path */}
          <div className="grid grid-cols-[100px_1fr] items-center gap-4">
            <span className="text-sm font-medium">{pathLabel}</span>
            <div className="flex items-center gap-2">
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
                className="flex-1"
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
            </div>
          </div>

          {/* Auto switch interval（folder/url） */}
          {sourceType !== 'file' && (
            <div className="grid grid-cols-[100px_1fr] items-center gap-4">
              <span className="text-sm font-medium">{t('Auto switch')}</span>
              <div className="flex items-center gap-2">
                <Switch
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
                      className="w-24"
                    />
                    <span className="text-sm text-muted-foreground">{t('seconds')}</span>
                  </>
                )}
              </div>
            </div>
          )}

          <PercentSliderRow
            label={t('Background visibility')}
            value={Math.round(opacity * 100)}
            onCommit={(v) => setOpacity(v / 100)}
          />
          <PercentSliderRow label={t('Blur')} value={blur} onCommit={setBlur} max={20} unit="px" />
          <PercentSliderRow
            label={t('Brightness')}
            value={Math.round(brightness * 100)}
            onCommit={(v) => setBrightness(v / 100)}
            max={200}
          />
          <PercentSliderRow
            label={t('Saturation')}
            value={Math.round(saturation * 100)}
            onCommit={(v) => setSaturation(v / 100)}
            max={200}
          />
          <PercentSliderRow
            label={t('Composer opacity')}
            value={Math.round(composerOpacity * 100)}
            onCommit={(v) => setComposerOpacity(v / 100)}
          />
          <PercentSliderRow
            label={t('Code block opacity')}
            value={Math.round(codeOpacity * 100)}
            onCommit={(v) => setCodeOpacity(v / 100)}
          />

          {/* Size mode */}
          <div className="grid grid-cols-[100px_1fr] items-center gap-4">
            <span className="text-sm font-medium">{t('Size mode')}</span>
            <Select
              items={sizeModeOptions}
              value={sizeMode}
              onValueChange={(v) => setSizeMode(v as BackgroundSizeMode)}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {sizeModeOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </>
      )}
    </>
  );
}

function TerminalPreview({
  theme,
  fontSize,
  fontFamily,
  fontWeight,
}: {
  theme: XtermTheme;
  fontSize: number;
  fontFamily: string;
  fontWeight: string;
}) {
  const sampleLines = [
    { id: 'prompt1', text: '$ ', color: theme.green },
    { id: 'cmd1', text: 'ls -la', color: theme.foreground },
    { id: 'nl1', text: '\n' },
    { id: 'perm1', text: 'drwxr-xr-x  ', color: theme.blue },
    { id: 'meta1', text: '5 user staff  160 Dec 23 ', color: theme.foreground },
    { id: 'dir1', text: 'Documents', color: theme.cyan },
    { id: 'nl2', text: '\n' },
    { id: 'perm2', text: '-rw-r--r--  ', color: theme.foreground },
    { id: 'meta2', text: '1 user staff 2048 Dec 22 ', color: theme.foreground },
    { id: 'file1', text: 'config.json', color: theme.yellow },
    { id: 'nl3', text: '\n\n' },
    { id: 'prompt2', text: '$ ', color: theme.green },
    { id: 'cmd2', text: 'echo "Hello, World!"', color: theme.foreground },
    { id: 'nl4', text: '\n' },
    { id: 'output1', text: 'Hello, World!', color: theme.magenta },
  ];

  return (
    <div
      className="rounded-lg border p-4 h-40 overflow-auto"
      style={{
        backgroundColor: theme.background,
        fontSize: `${fontSize}px`,
        fontFamily,
        fontWeight,
      }}
    >
      {sampleLines.map((segment) =>
        segment.text === '\n' ? (
          <br key={segment.id} />
        ) : segment.text === '\n\n' ? (
          <React.Fragment key={segment.id}>
            <br />
            <br />
          </React.Fragment>
        ) : (
          <span key={segment.id} style={{ color: segment.color }}>
            {segment.text}
          </span>
        )
      )}
      <span
        className="inline-block w-2 h-4 animate-pulse"
        style={{ backgroundColor: theme.cursor }}
      />
    </div>
  );
}

function FavoriteButton({
  isFavorite,
  onClick,
  ariaLabel,
}: {
  isFavorite: boolean;
  onClick: (e: React.MouseEvent) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={isFavorite}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick(e);
      }}
      className="p-1 hover:text-red-500 transition-colors"
    >
      {isFavorite ? (
        <Heart className="h-4 w-4 fill-red-500 text-red-500" />
      ) : (
        <Heart className="h-4 w-4" />
      )}
    </button>
  );
}

function ThemeCombobox({
  value,
  onValueChange,
  themes,
  favoriteThemes,
  onToggleFavorite,
  onThemeHover,
  showFavoritesOnly,
  onShowFavoritesOnlyChange,
  showEmptyFavoritesHint,
}: {
  value: string;
  onValueChange: (value: string | null) => void;
  themes: string[];
  favoriteThemes: string[];
  onToggleFavorite: (theme: string) => void;
  onThemeHover?: (theme: string) => void;
  showFavoritesOnly: boolean;
  onShowFavoritesOnlyChange: (checked: boolean) => void;
  showEmptyFavoritesHint?: boolean;
}) {
  const { t } = useI18n();
  // 使用内部值与外部值解耦，防止悬停时下拉框关闭
  const [internalValue, setInternalValue] = React.useState(value);
  const [search, setSearch] = React.useState(value);
  const [isOpen, setIsOpen] = React.useState(false);
  const hoverTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listRef = React.useRef<HTMLDivElement>(null);
  const originalValueRef = React.useRef<string>(value);
  const explicitSelectionRef = React.useRef(false);

  const favoriteSet = React.useMemo(() => new Set(favoriteThemes), [favoriteThemes]);

  // 仅在下拉框关闭时同步外部值
  React.useEffect(() => {
    if (!isOpen) {
      setInternalValue(value);
      setSearch(value);
    }
  }, [value, isOpen]);

  const filteredThemes = React.useMemo(() => {
    if (!search || search === internalValue) return themes;
    const query = search.toLowerCase();
    return themes.filter((name) => name.toLowerCase().includes(query));
  }, [themes, search, internalValue]);

  const handleValueChange = (newValue: string | null) => {
    if (newValue) {
      explicitSelectionRef.current = true;
      setInternalValue(newValue);
      setSearch(newValue);
    }
    onValueChange(newValue);
  };

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      originalValueRef.current = value;
      explicitSelectionRef.current = false;
      setInternalValue(value);
      setSearch(value);
    } else {
      // 关闭时如果没有显式选择，恢复原始主题
      if (!explicitSelectionRef.current) {
        onThemeHover?.(originalValueRef.current);
      }
    }
  };

  const handleItemMouseEnter = (themeName: string) => {
    clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => {
      onThemeHover?.(themeName);
    }, 50);
  };

  const handleItemMouseLeave = () => {
    clearTimeout(hoverTimeoutRef.current);
  };

  // 键盘导航时同步预览悬停主题
  React.useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        requestAnimationFrame(() => {
          const highlighted = listRef.current?.querySelector('[data-highlighted]');
          if (highlighted) {
            const themeName = highlighted.getAttribute('data-value');
            if (themeName) {
              onThemeHover?.(themeName);
            }
          }
        });
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isOpen, onThemeHover]);

  React.useEffect(() => {
    return () => {
      clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  return (
    <Combobox<string>
      value={internalValue}
      onValueChange={handleValueChange}
      inputValue={search}
      onInputValueChange={setSearch}
      open={isOpen}
      onOpenChange={handleOpenChange}
    >
      <div className="relative">
        <ComboboxInput placeholder={t('Search themes...')} />
        <div className="absolute right-8 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
          <Checkbox
            id="show-favorites-only-inner"
            checked={showFavoritesOnly}
            onCheckedChange={(checked) => onShowFavoritesOnlyChange(checked === true)}
            onClick={(e) => e.stopPropagation()}
          />
          <label
            htmlFor="show-favorites-only-inner"
            className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {t('Show favorites only')}
          </label>
        </div>
      </div>
      <ComboboxPopup>
        <ComboboxList ref={listRef}>
          {filteredThemes.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {showEmptyFavoritesHint
                ? t('No favorite themes yet. Click the heart icon to add favorites.')
                : t('No themes found')}
            </div>
          )}
          {filteredThemes.map((name) => (
            <ComboboxItem
              key={name}
              value={name}
              data-value={name}
              onMouseEnter={() => handleItemMouseEnter(name)}
              onMouseLeave={handleItemMouseLeave}
              endAddon={
                <FavoriteButton
                  isFavorite={favoriteSet.has(name)}
                  onClick={() => onToggleFavorite(name)}
                  ariaLabel={
                    favoriteSet.has(name) ? t('Remove from favorites') : t('Add to favorites')
                  }
                />
              }
            >
              {name}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

export function AppearanceSettings() {
  const {
    theme,
    setTheme,
    terminalTheme,
    setTerminalTheme,
    terminalFontSize: globalFontSize,
    setTerminalFontSize,
    terminalFontFamily: globalFontFamily,
    setTerminalFontFamily,
    terminalFontWeight,
    setTerminalFontWeight,
    terminalFontWeightBold,
    setTerminalFontWeightBold,
    favoriteTerminalThemes,
    toggleFavoriteTerminalTheme,
  } = useSettingsStore();
  const { t } = useI18n();

  const themeModeOptions: {
    value: Theme;
    icon: React.ElementType;
    label: string;
  }[] = [
    { value: 'light', icon: Sun, label: t('Light') },
    { value: 'dark', icon: Moon, label: t('Dark') },
    { value: 'system', icon: Monitor, label: t('System') },
    { value: 'sync-terminal', icon: Terminal, label: t('Sync terminal theme') },
  ];

  const [localFontSize, setLocalFontSize] = React.useState(globalFontSize);
  const [localFontFamily, setLocalFontFamily] = React.useState(globalFontFamily);
  const [showFavoritesOnly, setShowFavoritesOnly] = React.useState(false);

  React.useEffect(() => {
    setLocalFontSize(globalFontSize);
  }, [globalFontSize]);

  React.useEffect(() => {
    setLocalFontFamily(globalFontFamily);
  }, [globalFontFamily]);

  const applyFontSizeChange = React.useCallback(() => {
    const validFontSize = Math.max(8, Math.min(32, localFontSize || 8));
    if (validFontSize !== localFontSize) {
      setLocalFontSize(validFontSize);
    }
    if (validFontSize !== globalFontSize) {
      setTerminalFontSize(validFontSize);
    }
  }, [localFontSize, globalFontSize, setTerminalFontSize]);

  const applyFontFamilyChange = React.useCallback(() => {
    const validFontFamily = localFontFamily.trim() || globalFontFamily;
    if (validFontFamily !== localFontFamily) {
      setLocalFontFamily(validFontFamily);
    }
    if (validFontFamily !== globalFontFamily) {
      setTerminalFontFamily(validFontFamily);
    }
  }, [localFontFamily, globalFontFamily, setTerminalFontFamily]);

  const themeNames = React.useMemo(() => getThemeNames(), []);

  const displayThemes = React.useMemo(() => {
    if (!showFavoritesOnly) {
      return themeNames;
    }
    const favorites = themeNames.filter((name) => favoriteTerminalThemes.includes(name));
    // 当前选中的非收藏配色临时显示在列表第1位
    if (!favoriteTerminalThemes.includes(terminalTheme)) {
      return [terminalTheme, ...favorites];
    }
    return favorites;
  }, [themeNames, showFavoritesOnly, favoriteTerminalThemes, terminalTheme]);

  const showEmptyFavoritesHint = showFavoritesOnly && favoriteTerminalThemes.length === 0;

  const previewTheme = React.useMemo(() => {
    return getXtermTheme(terminalTheme) ?? defaultDarkTheme;
  }, [terminalTheme]);

  const handleThemeChange = (value: string | null) => {
    if (value) {
      setTerminalTheme(value);
    }
  };

  const handlePrevTheme = () => {
    const list = showFavoritesOnly ? displayThemes : themeNames;
    const idx = list.indexOf(terminalTheme);
    const newIndex = idx <= 0 ? list.length - 1 : idx - 1;
    setTerminalTheme(list[newIndex]);
  };

  const handleNextTheme = () => {
    const list = showFavoritesOnly ? displayThemes : themeNames;
    const idx = list.indexOf(terminalTheme);
    const newIndex = idx >= list.length - 1 ? 0 : idx + 1;
    setTerminalTheme(list[newIndex]);
  };

  return (
    <div className="space-y-6">
      {/* Theme Mode Section */}
      <div>
        <h3 className="text-lg font-medium">{t('Theme mode')}</h3>
        <p className="text-sm text-muted-foreground">{t('Choose interface theme')}</p>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {themeModeOptions.map((option) => (
          <button
            type="button"
            key={option.value}
            onClick={() => setTheme(option.value)}
            className={cn(
              'flex flex-col items-center gap-2 rounded-lg border-2 p-3 transition-colors',
              theme === option.value
                ? 'border-primary bg-accent text-accent-foreground'
                : 'border-transparent bg-muted/50 hover:bg-muted'
            )}
          >
            <div
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-full',
                theme === option.value
                  ? 'bg-accent-foreground/20 text-accent-foreground'
                  : 'bg-muted'
              )}
            >
              <option.icon className="h-5 w-5" />
            </div>
            <span className="text-sm font-medium">{option.label}</span>
          </button>
        ))}
      </div>

      {/* Terminal Section */}
      <div className="border-t pt-6">
        <h3 className="text-lg font-medium">{t('Terminal')}</h3>
        <p className="text-sm text-muted-foreground">{t('Terminal appearance')}</p>
      </div>

      {/* Preview */}
      <div className="space-y-2">
        <p className="text-sm font-medium">{t('Preview')}</p>
        <TerminalPreview
          theme={previewTheme}
          fontSize={localFontSize}
          fontFamily={localFontFamily}
          fontWeight={terminalFontWeight}
        />
      </div>

      {/* Theme Selector */}
      <div className="grid grid-cols-[100px_1fr] items-center gap-4">
        <span className="text-sm font-medium">{t('Color scheme')}</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={handlePrevTheme}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex-1">
            <ThemeCombobox
              value={terminalTheme}
              onValueChange={handleThemeChange}
              themes={displayThemes}
              favoriteThemes={favoriteTerminalThemes}
              onToggleFavorite={toggleFavoriteTerminalTheme}
              onThemeHover={setTerminalTheme}
              showFavoritesOnly={showFavoritesOnly}
              onShowFavoritesOnlyChange={setShowFavoritesOnly}
              showEmptyFavoritesHint={showEmptyFavoritesHint}
            />
          </div>
          <Button variant="outline" size="icon" onClick={handleNextTheme}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Font Family */}
      <div className="grid grid-cols-[100px_1fr] items-center gap-4">
        <span className="text-sm font-medium">{t('Font')}</span>
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
        />
      </div>

      {/* Font Size */}
      <div className="grid grid-cols-[100px_1fr] items-center gap-4">
        <span className="text-sm font-medium">{t('Font size')}</span>
        <div className="flex items-center gap-2">
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
            className="w-20"
          />
          <span className="text-sm text-muted-foreground">px</span>
        </div>
      </div>

      {/* Font Weight */}
      <div className="grid grid-cols-[100px_1fr] items-center gap-4">
        <span className="text-sm font-medium">{t('Font weight')}</span>
        <Select
          items={fontWeightOptions}
          value={terminalFontWeight}
          onValueChange={(v) => setTerminalFontWeight(v as FontWeight)}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {fontWeightOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {/* Font Weight Bold */}
      <div className="grid grid-cols-[100px_1fr] items-center gap-4">
        <span className="text-sm font-medium">{t('Bold font weight')}</span>
        <Select
          items={fontWeightOptions}
          value={terminalFontWeightBold}
          onValueChange={(v) => setTerminalFontWeightBold(v as FontWeight)}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {fontWeightOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {/* Background Image */}
      <BackgroundImageSettings />
    </div>
  );
}
