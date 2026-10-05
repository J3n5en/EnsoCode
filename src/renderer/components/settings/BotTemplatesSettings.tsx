import {
  parseTeamFile,
  TEAM_FILE_FORMAT,
  TEAM_FILE_VERSION,
  TEAM_MEMBERS_MAX,
  type TeamRefList,
} from '@shared/bots/team';
import {
  addCustomTemplate,
  type BotTemplateLibrary,
  type MemberTemplateData,
  parseMemberTemplate,
  parseTeamTemplate,
  type ResolvedTemplate,
  removeTemplate,
  saveTemplate,
  setTemplateHidden,
  type TeamTemplateData,
  type TeamTemplateMemberData,
  type TemplateSection,
  teamSpecOfTemplate,
  teamTemplateFromSpec,
  teamTemplateIssue,
} from '@shared/bots/templateLibrary';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Crown,
  Download,
  Eye,
  EyeOff,
  FileJson,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { BotAvatar } from '@/components/bots/BotAvatar';
import {
  ApprovalSelect,
  AVATAR_PALETTE,
  ColorPicker,
  FieldLabel,
  nameError,
  Segmented,
  TeamRefField,
} from '@/components/bots/BotFields';
import { teamFileErrorText } from '@/components/bots/botText';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { addToast } from '@/components/ui/toast';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import {
  BUILTIN_MEMBER_IDS,
  BUILTIN_TEAM_IDS,
  updateTemplateLibrary,
  useMemberTemplates,
  useTeamTemplates,
} from '@/stores/bots/templateLibrary';

type Kind = 'members' | 'teams';
type Editing<T> = { id?: string; data: T } | null;
type MemberFieldsValue = Omit<MemberTemplateData, 'summary'> & { summary?: string };

const blankMember = (): MemberTemplateData => ({
  name: '',
  title: '',
  scope: '',
  summary: '',
  persona: '',
  color: AVATAR_PALETTE[0],
  tools: 'all',
  approvalMode: 'auto-edits',
});

const blankTeamMember = (key: string, index: number): TeamTemplateMemberData => ({
  key,
  name: '',
  title: '',
  scope: '',
  persona: '',
  color: AVATAR_PALETTE[index % AVATAR_PALETTE.length],
  tools: 'all',
  approvalMode: 'auto-edits',
  canDelegateTo: [],
  acceptFrom: [],
});

const blankTeam = (): TeamTemplateData => ({
  title: '',
  summary: '',
  bossKey: 'm1',
  workspace: 'chat-home',
  members: [blankTeamMember('m1', 0), blankTeamMember('m2', 1)],
});

function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** 成员 / 团队模板库：内置可改、可隐藏、可恢复默认；自定义可增删改 */
export function BotTemplatesSettings() {
  const { t } = useI18n();
  const members = useMemberTemplates(true);
  const teams = useTeamTemplates(true);
  const [editingMember, setEditingMember] = useState<Editing<MemberTemplateData>>(null);
  const [editingTeam, setEditingTeam] = useState<Editing<TeamTemplateData>>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const edit = async <K extends Kind>(
    kind: K,
    mutate: (section: BotTemplateLibrary[K]) => BotTemplateLibrary[K]
  ) => {
    const ok = await updateTemplateLibrary((library) => ({
      ...library,
      [kind]: mutate(library[kind]),
    }));
    if (!ok) addToast({ type: 'error', title: t('Could not save templates') });
    return ok;
  };

  const saveMember = (id: string | undefined, data: MemberTemplateData) =>
    edit('members', (section) =>
      id
        ? saveTemplate(section, id, data, BUILTIN_MEMBER_IDS)
        : addCustomTemplate(section, data, crypto.randomUUID())
    );
  const saveTeam = (id: string | undefined, data: TeamTemplateData) =>
    edit('teams', (section) =>
      id
        ? saveTemplate(section, id, data, BUILTIN_TEAM_IDS)
        : addCustomTemplate(section, data, crypto.randomUUID())
    );

  const importTeam = async (file: File) => {
    const result = parseTeamFile(await file.text());
    if (!result.ok) {
      addToast({ type: 'error', title: teamFileErrorText(result.error, t) });
      return;
    }
    const data = parseTeamTemplate(teamTemplateFromSpec(result.team));
    if (!data) {
      addToast({ type: 'error', title: teamFileErrorText('invalid', t) });
      return;
    }
    if (await saveTeam(undefined, data))
      addToast({ type: 'success', title: t('Imported as a custom team template') });
  };

  const editSection = (
    kind: Kind,
    mutate: <T>(section: TemplateSection<T>) => TemplateSection<T>
  ) => (kind === 'members' ? edit('members', mutate) : edit('teams', mutate));

  const actions = <T,>(
    kind: Kind,
    item: ResolvedTemplate<T>,
    open: (editing: Editing<T>) => void
  ) => (
    <>
      <IconAction label={t('Edit')} onClick={() => open({ id: item.id, data: item.data })}>
        <Pencil />
      </IconAction>
      <IconAction label={t('Duplicate as custom')} onClick={() => open({ data: item.data })}>
        <Copy />
      </IconAction>
      {item.source === 'builtin' && (
        <IconAction
          label={item.hidden ? t('Show') : t('Hide')}
          onClick={() =>
            void editSection(kind, (section) => setTemplateHidden(section, item.id, !item.hidden))
          }
        >
          {item.hidden ? <Eye /> : <EyeOff />}
        </IconAction>
      )}
      {item.modified && (
        <IconAction
          label={t('Restore default')}
          onClick={() => void editSection(kind, (section) => removeTemplate(section, item.id))}
        >
          <RotateCcw />
        </IconAction>
      )}
      {item.source === 'custom' && (
        <IconAction
          label={t('Delete')}
          onClick={() => void editSection(kind, (section) => removeTemplate(section, item.id))}
        >
          <Trash2 />
        </IconAction>
      )}
    </>
  );

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">{t('Bot templates')}</h3>
        <p className="text-sm text-muted-foreground">
          {t(
            'Templates used when creating members and teams. Built-in templates can be edited, hidden or restored.'
          )}
        </p>
      </div>
      <Tabs defaultValue="members">
        <TabsList variant="underline">
          <TabsTab value="members">{t('Member templates')}</TabsTab>
          <TabsTab value="teams">{t('Team templates')}</TabsTab>
        </TabsList>
        <TabsPanel value="members" className="space-y-2 pt-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditingMember({ data: blankMember() })}
          >
            <Plus />
            {t('New member template')}
          </Button>
          {members.map((item) => (
            <TemplateRow
              key={item.id}
              item={item}
              avatar={
                <BotAvatar bot={{ name: item.data.name, avatar: { color: item.data.color } }} />
              }
              title={item.data.name}
              subtitle={item.data.title}
              summary={item.data.summary}
              actions={actions('members', item, setEditingMember)}
            />
          ))}
        </TabsPanel>
        <TabsPanel value="teams" className="space-y-2 pt-3">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditingTeam({ data: blankTeam() })}
            >
              <Plus />
              {t('New team template')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              <FileJson />
              {t('Import team (JSON)')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importTeam(file);
              }}
            />
          </div>
          {teams.map((item) => (
            <TemplateRow
              key={item.id}
              item={item}
              avatar={
                <div className="-space-x-1.5 flex shrink-0">
                  {item.data.members.slice(0, 4).map((member) => (
                    <BotAvatar
                      key={member.key}
                      size="sm"
                      bot={{ name: member.name, avatar: { color: member.color } }}
                    />
                  ))}
                </div>
              }
              title={item.data.title}
              subtitle={t('{{n}} members', { n: item.data.members.length })}
              summary={item.data.summary}
              actions={
                <>
                  <IconAction
                    label={t('Export JSON')}
                    onClick={() =>
                      downloadJson(`${item.data.title || 'team'}.team.json`, {
                        format: TEAM_FILE_FORMAT,
                        version: TEAM_FILE_VERSION,
                        exportedAt: new Date().toISOString(),
                        team: teamSpecOfTemplate(item.data),
                      })
                    }
                  >
                    <Download />
                  </IconAction>
                  {actions('teams', item, setEditingTeam)}
                </>
              }
            />
          ))}
        </TabsPanel>
      </Tabs>
      {editingMember && (
        <MemberTemplateDialog
          initial={editingMember.data}
          onClose={() => setEditingMember(null)}
          onSave={async (data) => {
            if (await saveMember(editingMember.id, data)) setEditingMember(null);
          }}
        />
      )}
      {editingTeam && (
        <TeamTemplateDialog
          initial={editingTeam.data}
          onClose={() => setEditingTeam(null)}
          onSave={async (data) => {
            if (await saveTeam(editingTeam.id, data)) setEditingTeam(null);
          }}
        />
      )}
    </div>
  );
}

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function TemplateRow<T>({
  item,
  avatar,
  title,
  subtitle,
  summary,
  actions,
}: {
  item: ResolvedTemplate<T>;
  avatar: React.ReactNode;
  title: string;
  subtitle: string;
  summary: string;
  actions: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div
      className="flex items-center gap-3 rounded-md border px-3 py-2.5"
      data-template-id={item.id}
    >
      <div className={cn('flex min-w-0 flex-1 items-center gap-3', item.hidden && 'opacity-50')}>
        {avatar}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{title}</span>
            <span className="truncate font-normal text-muted-foreground text-xs">{subtitle}</span>
            <Badge variant="secondary">
              {item.source === 'custom' ? t('Custom') : t('Built-in')}
            </Badge>
            {item.modified && <Badge variant="outline">{t('Modified')}</Badge>}
            {item.hidden && <Badge variant="outline">{t('Hidden')}</Badge>}
          </p>
          <p className="truncate text-muted-foreground text-xs">{summary}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center">{actions}</div>
    </div>
  );
}

function TemplateDialog({
  title,
  error,
  onClose,
  onSave,
  children,
}: {
  title: string;
  error: string | null;
  onClose: () => void;
  onSave: () => Promise<void>;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {children}
          {error && <p className="text-destructive text-xs">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            size="sm"
            disabled={busy || Boolean(error)}
            onClick={() => {
              setBusy(true);
              void onSave().finally(() => setBusy(false));
            }}
          >
            {t('Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberFields({
  value,
  onChange,
}: {
  value: MemberFieldsValue;
  onChange: (next: Partial<MemberFieldsValue>) => void;
}) {
  const { t } = useI18n();
  const issue = value.name ? nameError(value.name, [], t) : null;
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <FieldLabel>{t('Name')}</FieldLabel>
        <Input value={value.name} onChange={(event) => onChange({ name: event.target.value })} />
        {issue && <p className="mt-1 text-destructive text-xs">{issue}</p>}
      </div>
      <div>
        <FieldLabel>{t('Title')}</FieldLabel>
        <Input value={value.title} onChange={(event) => onChange({ title: event.target.value })} />
      </div>
      <div>
        <FieldLabel>{t('Avatar color')}</FieldLabel>
        <ColorPicker value={value.color} onChange={(color) => onChange({ color })} />
      </div>
      <div>
        <FieldLabel>{t('Tools')}</FieldLabel>
        <Segmented
          value={value.tools}
          options={[
            { value: 'all', label: t('All tools') },
            { value: 'readonly', label: t('Read-only') },
          ]}
          onChange={(tools) => onChange({ tools })}
        />
      </div>
      <div className="col-span-2">
        <FieldLabel>{t('Approval mode')}</FieldLabel>
        <ApprovalSelect
          value={value.approvalMode}
          onChange={(approvalMode) => onChange({ approvalMode })}
          zIndex={Z_INDEX.DROPDOWN_IN_MODAL}
        />
      </div>
      {value.summary !== undefined && (
        <div className="col-span-2">
          <FieldLabel hint={t('Shown on the template card')}>{t('Summary')}</FieldLabel>
          <Input
            value={value.summary}
            onChange={(event) => onChange({ summary: event.target.value })}
          />
        </div>
      )}
      <div className="col-span-2">
        <FieldLabel>{t('Responsibilities')}</FieldLabel>
        <Input value={value.scope} onChange={(event) => onChange({ scope: event.target.value })} />
      </div>
      <div className="col-span-2">
        <FieldLabel>{t('Persona')}</FieldLabel>
        <Textarea
          rows={6}
          value={value.persona}
          onChange={(event) => onChange({ persona: event.target.value })}
        />
      </div>
    </div>
  );
}

function MemberTemplateDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: MemberTemplateData;
  onClose: () => void;
  onSave: (data: MemberTemplateData) => Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initial);
  const parsed = parseMemberTemplate(draft);
  return (
    <TemplateDialog
      title={t('Member template')}
      error={nameError(draft.name, [], t) ?? (parsed ? null : t('Check the template fields'))}
      onClose={onClose}
      onSave={() => (parsed ? onSave(parsed) : Promise.resolve())}
    >
      <MemberFields
        value={draft}
        onChange={(next) => setDraft((current) => ({ ...current, ...next }))}
      />
    </TemplateDialog>
  );
}

function teamIssueText(issue: ReturnType<typeof teamTemplateIssue>, t: TFunction): string | null {
  switch (issue) {
    case 'title':
      return t('Enter a team title');
    case 'members':
      return t('A team needs 2–12 members');
    case 'name':
      return t('Every member needs a valid name');
    case 'invalid':
      return t('Check the template fields');
    default:
      return null;
  }
}

function TeamTemplateDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: TeamTemplateData;
  onClose: () => void;
  onSave: (data: TeamTemplateData) => Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initial);
  const [expanded, setExpanded] = useState<string | null>(null);
  const nameOf = (key: string) => draft.members.find((member) => member.key === key)?.name || key;
  const patch = (next: Partial<TeamTemplateData>) =>
    setDraft((current) => ({ ...current, ...next }));
  const patchMember = (key: string, next: Partial<TeamTemplateMemberData>) =>
    setDraft((current) => ({
      ...current,
      members: current.members.map((m) => (m.key === key ? { ...m, ...next } : m)),
    }));
  const addMember = () => {
    const keys = new Set(draft.members.map((member) => member.key));
    let n = draft.members.length + 1;
    while (keys.has(`m${n}`)) n++;
    const key = `m${n}`;
    patch({ members: [...draft.members, blankTeamMember(key, draft.members.length)] });
    setExpanded(key);
  };
  const removeMember = (key: string) => {
    const prune = (list: TeamRefList): TeamRefList =>
      list === 'any' ? 'any' : list.filter((item) => item !== key);
    patch({
      members: draft.members
        .filter((member) => member.key !== key)
        .map((member) => ({
          ...member,
          canDelegateTo: prune(member.canDelegateTo),
          acceptFrom: prune(member.acceptFrom),
        })),
    });
  };
  const parsed = parseTeamTemplate(draft);
  return (
    <TemplateDialog
      title={t('Team template')}
      error={teamIssueText(teamTemplateIssue(draft), t)}
      onClose={onClose}
      onSave={() => (parsed ? onSave(parsed) : Promise.resolve())}
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>{t('Group name')}</FieldLabel>
          <Input value={draft.title} onChange={(event) => patch({ title: event.target.value })} />
        </div>
        <div>
          <FieldLabel>{t('Owner')}</FieldLabel>
          <Select
            items={draft.members.map((member) => ({
              value: member.key,
              label: nameOf(member.key),
            }))}
            value={draft.bossKey}
            onValueChange={(value) => patch({ bossKey: value as string })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup zIndex={Z_INDEX.DROPDOWN_IN_MODAL}>
              {draft.members.map((member) => (
                <SelectItem key={member.key} value={member.key}>
                  {nameOf(member.key)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="col-span-2">
          <FieldLabel hint={t('Shown on the template card')}>{t('Summary')}</FieldLabel>
          <Input
            value={draft.summary}
            onChange={(event) => patch({ summary: event.target.value })}
          />
        </div>
        <div className="col-span-2">
          <FieldLabel>{t('Shared workspace')}</FieldLabel>
          <Segmented
            value={draft.workspace}
            options={[
              { value: 'chat-home', label: t('Standalone workspace') },
              { value: 'project', label: t('Based on a Code project') },
            ]}
            onChange={(workspace) => patch({ workspace })}
          />
        </div>
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-muted-foreground text-xs">{t('Members')}</span>
          <Button
            size="xs"
            variant="outline"
            disabled={draft.members.length >= TEAM_MEMBERS_MAX}
            onClick={addMember}
          >
            <Plus />
            {t('Add member')}
          </Button>
        </div>
        <div className="space-y-1.5">
          {draft.members.map((member) => {
            const open = expanded === member.key;
            const boss = member.key === draft.bossKey;
            const others = draft.members.filter((m) => m.key !== member.key).map((m) => m.key);
            return (
              <div key={member.key} className="rounded-lg border" data-member-key={member.key}>
                <div className="flex items-center gap-2 px-2.5 py-2">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setExpanded(open ? null : member.key)}
                  >
                    {open ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <BotAvatar
                      bot={{ name: member.name, avatar: { color: member.color } }}
                      size="sm"
                    />
                    <span className="truncate text-sm">{member.name || t('Unnamed')}</span>
                    <span className="truncate text-muted-foreground text-xs">{member.title}</span>
                    {boss && (
                      <span className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                        <Crown className="h-3 w-3" />
                        {t('Owner')}
                      </span>
                    )}
                  </button>
                  <IconAction
                    label={t('Remove')}
                    disabled={boss || draft.members.length <= 2}
                    onClick={() => removeMember(member.key)}
                  >
                    <Trash2 />
                  </IconAction>
                </div>
                {open && (
                  <div className="space-y-3 border-t p-2.5">
                    <MemberFields
                      value={member}
                      onChange={(next) => patchMember(member.key, next)}
                    />
                    <TeamRefField
                      label={t('Can delegate to')}
                      value={member.canDelegateTo}
                      options={others}
                      nameOf={nameOf}
                      onChange={(canDelegateTo) => patchMember(member.key, { canDelegateTo })}
                    />
                    <TeamRefField
                      label={t('Accepts delegation from')}
                      value={member.acceptFrom}
                      options={others}
                      nameOf={nameOf}
                      onChange={(acceptFrom) => patchMember(member.key, { acceptFrom })}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </TemplateDialog>
  );
}
