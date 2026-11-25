import { type TerminalShell, terminalShellsForPlatform } from '@shared/terminalShell';
import type { WindowsLocalShell } from '@shared/windowsLocalShell';
import { ChevronLeft, ChevronRight, Heart } from 'lucide-react';
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
import { useI18n } from '@/i18n';
import {
  defaultDarkTheme,
  getThemeNames,
  getXtermTheme,
  type XtermTheme,
} from '@/lib/ghosttyTheme';
import { cn } from '@/lib/utils';
import { type FontWeight, useSettingsStore } from '@/stores/settings';
import { fontWeightOptions } from './constants';
import { SettingsPage, SettingsPreview, SettingsRow, SettingsSection, SettingsSelect } from './kit';
import { NewSessionBadge } from './NewSessionBadge';

const TERMINAL_SHELL_LABELS: Record<Exclude<TerminalShell, 'auto'>, string> = {
  cmd: 'Command Prompt',
  powershell: 'Windows PowerShell',
  pwsh: 'PowerShell 7 (pwsh)',
  'git-bash': 'Git Bash',
  zsh: 'zsh',
  bash: 'bash',
  fish: 'fish',
};

function WindowsLocalShellRow() {
  const { t } = useI18n();
  const windowsLocalShell = useSettingsStore((s) => s.windowsLocalShell);
  const setWindowsLocalShell = useSettingsStore((s) => s.setWindowsLocalShell);
  const options: { value: WindowsLocalShell; label: string }[] = [
    { value: 'auto', label: t('Windows default (PowerShell)') },
    { value: 'powershell', label: t('PowerShell') },
    { value: 'bash', label: t('Git Bash') },
  ];
  return (
    <SettingsRow
      rowId="general.windowsLocalShell"
      label={
        <span className="inline-flex flex-wrap items-center">
          {t('Windows local command shell')}
          <NewSessionBadge />
        </span>
      }
      description={t(
        'Only the Windows local agent command tool. SSH and other platforms stay on bash. Takes effect on the next session.'
      )}
    >
      <SettingsSelect
        value={windowsLocalShell}
        options={options}
        onValueChange={setWindowsLocalShell}
      />
    </SettingsRow>
  );
}

function TerminalShellRow() {
  const { t } = useI18n();
  const terminalShell = useSettingsStore((s) => s.terminalShell);
  const setTerminalShell = useSettingsStore((s) => s.setTerminalShell);
  const values = terminalShellsForPlatform(window.electronAPI.env.platform);
  const options = values.map((value) => ({
    value,
    label: value === 'auto' ? t('System default') : TERMINAL_SHELL_LABELS[value],
  }));
  return (
    <SettingsRow
      rowId="general.terminalShell"
      label={t('Terminal shell')}
      description={t(
        'Applies to new side panel terminals. SSH projects keep the remote login shell.'
      )}
    >
      <SettingsSelect value={terminalShell} options={options} onValueChange={setTerminalShell} />
    </SettingsRow>
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
    <SettingsPreview
      className="h-40 max-w-full overflow-auto p-4"
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
        className="inline-block h-4 w-2 animate-pulse"
        style={{ backgroundColor: theme.cursor }}
      />
    </SettingsPreview>
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
      className="p-1 text-muted-foreground transition-colors hover:text-destructive"
    >
      <Heart className={cn('h-4 w-4', isFavorite && 'fill-destructive text-destructive')} />
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
  const [internalValue, setInternalValue] = React.useState(value);
  const [search, setSearch] = React.useState(value);
  const [isOpen, setIsOpen] = React.useState(false);
  const hoverTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listRef = React.useRef<HTMLDivElement>(null);
  const originalValueRef = React.useRef<string>(value);
  const explicitSelectionRef = React.useRef(false);
  const favoriteSet = React.useMemo(() => new Set(favoriteThemes), [favoriteThemes]);

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
    } else if (!explicitSelectionRef.current) {
      onThemeHover?.(originalValueRef.current);
    }
  };

  const handleItemMouseEnter = (themeName: string) => {
    clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => {
      onThemeHover?.(themeName);
    }, 50);
  };

  React.useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      requestAnimationFrame(() => {
        const highlighted = listRef.current?.querySelector('[data-highlighted]');
        const themeName = highlighted?.getAttribute('data-value');
        if (themeName) onThemeHover?.(themeName);
      });
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onThemeHover]);

  React.useEffect(() => () => clearTimeout(hoverTimeoutRef.current), []);

  return (
    <Combobox<string>
      value={internalValue}
      onValueChange={handleValueChange}
      inputValue={search}
      onInputValueChange={setSearch}
      open={isOpen}
      onOpenChange={handleOpenChange}
    >
      <div className="relative w-[min(100%,280px)] min-w-0">
        <ComboboxInput placeholder={t('Search themes...')} />
      </div>
      <ComboboxPopup>
        <div
          data-enso="theme-favorites-filter"
          className="flex items-center gap-1.5 border-border border-b px-2.5 py-2"
        >
          <Checkbox
            id="show-favorites-only-inner"
            checked={showFavoritesOnly}
            onCheckedChange={(checked) => onShowFavoritesOnlyChange(checked === true)}
          />
          <label
            htmlFor="show-favorites-only-inner"
            className="cursor-pointer select-none text-xs text-muted-foreground"
          >
            {t('Show favorites only')}
          </label>
        </div>
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
              onMouseLeave={() => clearTimeout(hoverTimeoutRef.current)}
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

function TerminalAppearance() {
  const { t } = useI18n();
  const terminalTheme = useSettingsStore((s) => s.terminalTheme);
  const setTerminalTheme = useSettingsStore((s) => s.setTerminalTheme);
  const globalFontSize = useSettingsStore((s) => s.terminalFontSize);
  const globalFontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const terminalFontWeight = useSettingsStore((s) => s.terminalFontWeight);
  const setTerminalFontWeight = useSettingsStore((s) => s.setTerminalFontWeight);
  const terminalFontWeightBold = useSettingsStore((s) => s.terminalFontWeightBold);
  const setTerminalFontWeightBold = useSettingsStore((s) => s.setTerminalFontWeightBold);
  const favoriteTerminalThemes = useSettingsStore((s) => s.favoriteTerminalThemes);
  const toggleFavoriteTerminalTheme = useSettingsStore((s) => s.toggleFavoriteTerminalTheme);
  const [localFontFamily, setLocalFontFamily] = React.useState(globalFontFamily);
  const [showFavoritesOnly, setShowFavoritesOnly] = React.useState(false);

  React.useEffect(() => {
    setLocalFontFamily(globalFontFamily);
  }, [globalFontFamily]);

  const themeNames = React.useMemo(() => getThemeNames(), []);
  const displayThemes = React.useMemo(() => {
    if (!showFavoritesOnly) return themeNames;
    const favorites = themeNames.filter((name) => favoriteTerminalThemes.includes(name));
    if (!favoriteTerminalThemes.includes(terminalTheme)) return [terminalTheme, ...favorites];
    return favorites;
  }, [themeNames, showFavoritesOnly, favoriteTerminalThemes, terminalTheme]);
  const showEmptyFavoritesHint = showFavoritesOnly && favoriteTerminalThemes.length === 0;
  const previewTheme = React.useMemo(
    () => getXtermTheme(terminalTheme) ?? defaultDarkTheme,
    [terminalTheme]
  );

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
    <div data-settings-row="terminal.appearance" className="space-y-4">
      <SettingsSection bare rowId="terminal.appearance" title={t('Terminal appearance')}>
        <TerminalPreview
          theme={previewTheme}
          fontSize={globalFontSize}
          fontFamily={localFontFamily}
          fontWeight={terminalFontWeight}
        />
      </SettingsSection>
      <SettingsSection>
        <SettingsRow
          rowId="terminal.color-scheme"
          label={t('Color scheme')}
          description={t('Also used by command output in conversations')}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="outline" size="icon" onClick={handlePrevTheme}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <ThemeCombobox
              value={terminalTheme}
              onValueChange={(value) => {
                if (value) setTerminalTheme(value);
              }}
              themes={displayThemes}
              favoriteThemes={favoriteTerminalThemes}
              onToggleFavorite={toggleFavoriteTerminalTheme}
              onThemeHover={setTerminalTheme}
              showFavoritesOnly={showFavoritesOnly}
              onShowFavoritesOnlyChange={setShowFavoritesOnly}
              showEmptyFavoritesHint={showEmptyFavoritesHint}
            />
            <Button variant="outline" size="icon" onClick={handleNextTheme}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow rowId="terminal.font-weight" label={t('Font weight')}>
          <SettingsSelect
            value={terminalFontWeight}
            options={fontWeightOptions}
            onValueChange={(value) => setTerminalFontWeight(value as FontWeight)}
          />
        </SettingsRow>
        <SettingsRow rowId="terminal.bold-font-weight" label={t('Bold font weight')}>
          <SettingsSelect
            value={terminalFontWeightBold}
            options={fontWeightOptions}
            onValueChange={(value) => setTerminalFontWeightBold(value as FontWeight)}
          />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

export function TerminalSettings() {
  const { t } = useI18n();
  return (
    <SettingsPage rowId="terminal.root" title={t('Terminal')}>
      <SettingsSection rowId="terminal.shell" title={t('Shell')}>
        <WindowsLocalShellRow />
        <TerminalShellRow />
      </SettingsSection>
      <TerminalAppearance />
    </SettingsPage>
  );
}
