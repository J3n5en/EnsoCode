import {
  CHAT_TYPOGRAPHY_ROLES,
  CHAT_TYPOGRAPHY_SPEC,
  CHAT_TYPOGRAPHY_WEIGHTS,
  type ChatTypographyRole,
  type ChatTypographyWeight,
} from '@shared/chatTypography';
import { liveActivityFoldDelaySec as normalizeLiveActivityFoldDelaySec } from '@shared/liveActivityFoldDelay';
import * as React from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { ACTIVE_RETENTION_MINUTES } from '@/stores/settings/activeRetention';
import {
  SettingsButton,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsSwitch,
} from './kit';

const CHAT_ROLE_LABELS = {
  body: 'Body',
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4–6',
  table: 'Table',
  inlineCode: 'Inline code',
  codeBlock: 'Code block',
} as const satisfies Record<ChatTypographyRole, string>;

const CHAT_WEIGHT_ITEMS = CHAT_TYPOGRAPHY_WEIGHTS.map((weight) => ({
  value: String(weight),
  label: String(weight),
}));

function ChatTypographySection() {
  const { t } = useI18n();
  const typography = useSettingsStore((s) => s.chatTypography);
  const setChatTypography = useSettingsStore((s) => s.setChatTypography);
  const resetChatTypography = useSettingsStore((s) => s.resetChatTypography);
  const [bodyPreview, setBodyPreview] = React.useState(typography.body.size);
  React.useEffect(() => {
    setBodyPreview(typography.body.size);
  }, [typography.body.size]);

  const commit = (role: ChatTypographyRole, size: number) => {
    const current = useSettingsStore.getState().chatTypography;
    setChatTypography({ ...current, [role]: { ...current[role], size } });
  };
  const commitWeight = (role: ChatTypographyRole, weight: ChatTypographyWeight) => {
    const current = useSettingsStore.getState().chatTypography;
    setChatTypography({ ...current, [role]: { ...current[role], weight } });
  };

  return (
    <SettingsSection
      rowId="appearance.chatTypography"
      title={t('Conversation typography')}
      description={t('Headings, tables and inline code scale with the body text')}
    >
      {CHAT_TYPOGRAPHY_ROLES.map((role) => (
        <RoleSlider
          key={role}
          role={role}
          label={t(CHAT_ROLE_LABELS[role])}
          size={typography[role].size}
          weight={typography[role].weight}
          bodyPreview={bodyPreview}
          onPreview={role === 'body' ? setBodyPreview : undefined}
          onCommit={(size) => commit(role, size)}
          onWeight={(weight) => commitWeight(role, weight)}
        />
      ))}
      <div className="flex justify-end px-4 py-2.5 max-sm:px-3">
        <SettingsButton
          onClick={() => {
            resetChatTypography();
            addToast({ type: 'info', title: t('Reset to defaults') });
          }}
        >
          {t('Reset to defaults')}
        </SettingsButton>
      </div>
    </SettingsSection>
  );
}

function RoleSlider({
  role,
  label,
  size,
  weight,
  bodyPreview,
  onPreview,
  onCommit,
  onWeight,
}: {
  role: ChatTypographyRole;
  label: string;
  size: number;
  weight: ChatTypographyWeight;
  bodyPreview: number;
  onPreview?: (value: number) => void;
  onCommit: (value: number) => void;
  onWeight: (weight: ChatTypographyWeight) => void;
}) {
  const spec = CHAT_TYPOGRAPHY_SPEC[role];
  const [local, setLocal] = React.useState(size);
  React.useEffect(() => {
    setLocal(size);
  }, [size]);
  const suffix = spec.unit === '%' ? `${((bodyPreview * local) / 100).toFixed(1)}px` : undefined;
  return (
    <SettingsRow label={label}>
      <div className="w-[140px] sm:w-[180px]">
        <Slider
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={local}
          onValueChange={(next) => {
            const value = Array.isArray(next) ? next[0] : next;
            setLocal(value);
            onPreview?.(value);
          }}
          onValueCommitted={(next) => onCommit(Array.isArray(next) ? next[0] : next)}
        />
      </div>
      <span className="shrink-0 text-right text-[12px] text-muted-foreground tabular-nums">
        {local}
        {spec.unit === '%' ? '%' : 'px'}
        {suffix ? ` · ${suffix}` : ''}
      </span>
      <Select
        items={CHAT_WEIGHT_ITEMS}
        value={String(weight)}
        onValueChange={(value) => {
          const next = Number(value);
          if (!(CHAT_TYPOGRAPHY_WEIGHTS as readonly number[]).includes(next)) return;
          onWeight(next as ChatTypographyWeight);
        }}
      >
        <SelectTrigger size="sm" className="w-24 max-w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {CHAT_WEIGHT_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </SettingsRow>
  );
}

function LiveFoldDelayRow({
  seconds,
  onCommit,
}: {
  seconds: number;
  onCommit: (value: number) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(String(seconds));
  React.useEffect(() => setDraft(String(seconds)), [seconds]);
  const commit = () => {
    const value = Number(draft);
    if (!Number.isInteger(value)) {
      setDraft(String(seconds));
      return;
    }
    const next = normalizeLiveActivityFoldDelaySec(value);
    onCommit(next);
    setDraft(String(next));
  };
  return (
    <SettingsRow
      rowId="appearance.liveActivityFoldDelaySec"
      label={t('Wait before folding')}
      description={t('Seconds to wait after tools and thinking finish')}
    >
      <Input
        type="number"
        min={1}
        max={60}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
            event.currentTarget.blur();
          }
        }}
        className="w-20 max-w-full"
      />
      <span className="text-[12px] text-muted-foreground">{t('sec')}</span>
    </SettingsRow>
  );
}

function Toggle({
  rowId,
  label,
  description,
  checked,
  onChange,
  extra,
}: {
  rowId: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  extra?: React.ReactNode;
}) {
  return (
    <SettingsRow rowId={rowId} label={label} description={description}>
      {extra}
      <SettingsSwitch checked={checked} onCheckedChange={(value) => onChange(value === true)} />
    </SettingsRow>
  );
}

export function ConversationSettings({ revealRowId }: { revealRowId?: string | null } = {}) {
  const { t } = useI18n();
  const openChangesOnFileEdit = useSettingsStore((s) => s.openChangesOnFileEdit);
  const setOpenChangesOnFileEdit = useSettingsStore((s) => s.setOpenChangesOnFileEdit);
  const compactReadOnlyTools = useSettingsStore((s) => s.compactReadOnlyTools);
  const setCompactReadOnlyTools = useSettingsStore((s) => s.setCompactReadOnlyTools);
  const expandLiveEdits = useSettingsStore((s) => s.expandLiveEdits);
  const setExpandLiveEdits = useSettingsStore((s) => s.setExpandLiveEdits);
  const expandLiveReasoning = useSettingsStore((s) => s.expandLiveReasoning);
  const setExpandLiveReasoning = useSettingsStore((s) => s.setExpandLiveReasoning);
  const autoCollapseTurns = useSettingsStore((s) => s.autoCollapseTurns);
  const setAutoCollapseTurns = useSettingsStore((s) => s.setAutoCollapseTurns);
  const quoteSelectionButton = useSettingsStore((s) => s.quoteSelectionButton);
  const setQuoteSelectionButton = useSettingsStore((s) => s.setQuoteSelectionButton);
  const collapseCompletedActivity = useSettingsStore((s) => s.collapseCompletedActivity);
  const setCollapseCompletedActivity = useSettingsStore((s) => s.setCollapseCompletedActivity);
  const collapseLiveActivity = useSettingsStore((s) => s.collapseLiveActivity);
  const setCollapseLiveActivity = useSettingsStore((s) => s.setCollapseLiveActivity);
  const liveActivityFoldDelaySec = useSettingsStore((s) => s.liveActivityFoldDelaySec);
  const setLiveActivityFoldDelaySec = useSettingsStore((s) => s.setLiveActivityFoldDelaySec);
  const pinUnfinishedTodos = useSettingsStore((s) => s.pinUnfinishedTodos);
  const setPinUnfinishedTodos = useSettingsStore((s) => s.setPinUnfinishedTodos);
  const headerSessionTabs = useSettingsStore((s) => s.headerSessionTabs);
  const setHeaderSessionTabs = useSettingsStore((s) => s.setHeaderSessionTabs);
  const headerRecentMinutes = useSettingsStore((s) => s.headerRecentMinutes);
  const setHeaderRecentMinutes = useSettingsStore((s) => s.setHeaderRecentMinutes);
  const navRailSide = useSettingsStore((s) => s.navRailSide);
  const setNavRailSide = useSettingsStore((s) => s.setNavRailSide);
  const recentLabel = (value: number) =>
    value === 0 ? t('Off') : t('{{count}} min', { count: value });
  const railOptions: { value: 'left' | 'right' | 'off'; label: string }[] = [
    { value: 'left', label: t('Left') },
    { value: 'right', label: t('Right') },
    { value: 'off', label: t('Off') },
  ];

  return (
    <SettingsPage rowId="conversation.root" title={t('Conversation display')}>
      <ChatTypographySection />
      <SettingsSection>
        <SettingsRow
          rowId="appearance.navRailSide"
          label={t('Turn marks')}
          description={t(
            'Marks along the conversation for each turn. Hover to preview, click to jump. Hidden when the chat uses the full width.'
          )}
        >
          <SettingsSegmented
            value={navRailSide}
            onValueChange={setNavRailSide}
            options={railOptions}
          />
        </SettingsRow>
        <Toggle
          rowId="appearance.openChangesOnFileEdit"
          label={t('Open Changes when files are edited')}
          description={t(
            'Automatically show the side panel Changes tab after the agent edits a file'
          )}
          checked={openChangesOnFileEdit}
          onChange={setOpenChangesOnFileEdit}
        />
        <Toggle
          rowId="appearance.compactReadOnlyTools"
          label={t('Compact read-only tool calls')}
          description={t(
            'Show read/grep/find/ls as one-line rows and fold consecutive tool calls while the agent is still running'
          )}
          checked={compactReadOnlyTools}
          onChange={setCompactReadOnlyTools}
        />
        <Toggle
          rowId="appearance.expandLiveEdits"
          label={t('Expand file edits while running')}
          description={t(
            'Automatically unfold diffs or written content from file modification tools while the agent is still running'
          )}
          checked={expandLiveEdits}
          onChange={setExpandLiveEdits}
        />
        <Toggle
          rowId="appearance.expandLiveReasoning"
          label={t('Expand reasoning while streaming')}
          description={t(
            'Automatically unfold the thinking block while the model is still reasoning. It collapses again when reasoning ends.'
          )}
          checked={expandLiveReasoning}
          onChange={setExpandLiveReasoning}
        />
        <Toggle
          rowId="appearance.autoCollapseTurns"
          label={t('Auto-collapse previous turns')}
          description={t(
            'After you send a new message, fold earlier turns down to the question, timestamp and duration; the latest turn stays expanded'
          )}
          checked={autoCollapseTurns}
          onChange={setAutoCollapseTurns}
        />
        <Toggle
          rowId="appearance.quoteSelectionButton"
          label={t('Quote button on text selection')}
          description={t(
            'Show a floating Quote button when you select text in the conversation; click it to put the selection into the input box as a quote'
          )}
          checked={quoteSelectionButton}
          onChange={setQuoteSelectionButton}
        />
        <Toggle
          rowId="appearance.collapseCompletedActivity"
          label={t('Collapse activity after reply')}
          description={t(
            'When a reply finishes, fold consecutive thinking and tool calls (including edits and commands) into one summary row; failed calls stay visible'
          )}
          checked={collapseCompletedActivity}
          onChange={setCollapseCompletedActivity}
        />
        <Toggle
          rowId="appearance.collapseLiveActivity"
          label={t('Collapse finished activity while replying')}
          description={t(
            'While a reply is still running, wait a moment after tools and thinking finish, then fold that stretch into one row. Calls still running stay visible, and failed calls stay visible'
          )}
          checked={collapseLiveActivity}
          onChange={setCollapseLiveActivity}
        />
        {collapseLiveActivity || revealRowId === 'appearance.liveActivityFoldDelaySec' ? (
          <LiveFoldDelayRow
            seconds={liveActivityFoldDelaySec}
            onCommit={setLiveActivityFoldDelaySec}
          />
        ) : null}
        <Toggle
          rowId="appearance.pinUnfinishedTodos"
          label={t('Pin unfinished todos')}
          description={t(
            'Keep the latest todo list above the input while it has unfinished items, so it does not scroll away with the timeline'
          )}
          checked={pinUnfinishedTodos}
          onChange={setPinUnfinishedTodos}
        />
        <Toggle
          rowId="appearance.headerSessionTabs"
          label={t('Show active sessions in the title bar')}
          description={t(
            'Show active conversations as tabs above the conversation. Hold ⌘/Ctrl to see number shortcuts. Hidden while Bot mode is enabled.'
          )}
          checked={headerSessionTabs}
          onChange={setHeaderSessionTabs}
          extra={
            headerSessionTabs ? (
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                <span className="max-w-full text-[12px] text-muted-foreground">
                  {t('Also show recent conversations')}
                </span>
                <Select
                  items={Object.fromEntries(
                    ACTIVE_RETENTION_MINUTES.map((value) => [String(value), recentLabel(value)])
                  )}
                  value={String(headerRecentMinutes)}
                  onValueChange={(value) => setHeaderRecentMinutes(Number(value))}
                >
                  <SelectTrigger size="sm" className="w-28 max-w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {ACTIVE_RETENTION_MINUTES.map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {recentLabel(value)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null
          }
        />
      </SettingsSection>
    </SettingsPage>
  );
}
