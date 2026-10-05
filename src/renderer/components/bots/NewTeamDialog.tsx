import {
  selectTeamMembers,
  type TeamMemberAssets,
  type TeamMemberSpec,
  type TeamRename,
  type TeamSpec,
} from '@shared/bots/team';
import { teamSpecOfTemplate } from '@shared/bots/templateLibrary';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Crown,
  FileJson,
  Info,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { APPROVAL_MODE_META } from '@/components/chat/ApprovalModePicker';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import { useBotsStore } from '@/stores/bots';
import { useTeamTemplates } from '@/stores/bots/templateLibrary';
import { useSettingsStore } from '@/stores/settings';
import { AssetPickers, suggestErrorText } from './BotAbilities';
import { BotAvatar } from './BotAvatar';
import { ApprovalSelect, FieldLabel, nameError, Segmented, TeamRefField } from './BotFields';
import { BotProjectPicker } from './BotProjectPicker';
import { botErrorText, chatErrorText, localProjects, teamFileErrorText } from './botText';

type Assets = Record<string, { skillIds: string[]; mcpServerIds: string[] }>;
const NO_ASSETS = { skillIds: [] as string[], mcpServerIds: [] as string[] };

interface Preview {
  team: TeamSpec;
  renamed: TeamRename[];
  picked: string[];
}

/** 从内置模板或团队文件创建：预览成员（可取消、改名）→ Main 原子创建成员与群 */
export function NewTeamDialog({
  open,
  onOpenChange,
  seedTemplateId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 目标式引导推荐的模板：打开即进入该模板的预览 */
  seedTemplateId?: string;
  /** 创建并打开群聊后回调（引导据此预填第一条消息） */
  onCreated?: (chatId: string) => void;
}) {
  const { t, locale } = useI18n();
  const bots = useBotsStore((s) => s.bots);
  const templates = useTeamTemplates();
  const projects = localProjects(useSettingsStore((s) => s.projects));
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [workspace, setWorkspace] = useState<'project' | 'chat-home'>('chat-home');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<Assets>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次打开重置
  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setProjectId(projects[0]?.id ?? '');
    setBusy(false);
    setError(null);
    setAssets({});
    setExpanded(null);
    const template = templates.find((item) => item.id === seedTemplateId);
    if (template) void load({ team: teamSpecOfTemplate(template.data) });
  }, [open]);

  const load = async (request: { team: TeamSpec } | { text: string }) => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.bots.previewTeam(request);
      if (!result.ok) {
        setError(teamFileErrorText(result.error, t));
        return;
      }
      setPreview({
        team: result.team,
        renamed: result.renamed,
        picked: result.team.members.map((member) => member.key),
      });
      setAssets({});
      setExpanded(null);
      setWorkspace(
        result.team.workspace === 'project' && projects.length > 0 ? 'project' : 'chat-home'
      );
    } finally {
      setBusy(false);
    }
  };

  const patchTeam = (patch: (team: TeamSpec) => TeamSpec) =>
    setPreview((current) => (current ? { ...current, team: patch(current.team) } : current));
  const patchMember = (key: string, next: Partial<TeamMemberSpec>) =>
    patchTeam((team) => ({
      ...team,
      members: team.members.map((m) => (m.key === key ? { ...m, ...next } : m)),
    }));

  const picked = useMemo(
    () => (preview ? selectTeamMembers(preview.team, preview.picked) : null),
    [preview]
  );
  const nameIssues = useMemo(() => {
    const issues = new Map<string, string>();
    if (!picked) return issues;
    const others = [
      ...bots,
      ...picked.members.map((member) => ({ id: `team:${member.key}`, name: member.name })),
    ];
    for (const member of picked.members) {
      const issue = nameError(member.name, others, t, `team:${member.key}`);
      if (issue) issues.set(member.key, issue);
    }
    return issues;
  }, [picked, bots, t]);

  const canCreate =
    picked !== null &&
    nameIssues.size === 0 &&
    (workspace === 'chat-home' || Boolean(projectId)) &&
    !busy &&
    !suggesting;

  const assetsOf = (key: string) => assets[key] ?? NO_ASSETS;
  const setMemberAssets = (key: string, next: Partial<typeof NO_ASSETS>) =>
    setAssets((current) => ({ ...current, [key]: { ...(current[key] ?? NO_ASSETS), ...next } }));

  /** 逐个成员问 Bot 助理模型：取工具、审批、技能、MCP；委派名单按团队内成员手动设 */
  const autoAssets = async () => {
    if (!picked) return;
    setSuggesting(true);
    try {
      const language = locale === 'zh' ? 'zh' : 'en';
      const results = await Promise.all(
        picked.members.map(async (member) => {
          try {
            const result = await window.electronAPI.bots.suggestAbilities({
              name: member.name,
              title: member.title,
              scope: member.scope,
              persona: member.persona,
              language,
            });
            return { key: member.key, result };
          } catch {
            return { key: member.key, result: null };
          }
        })
      );
      let set = 0;
      let failed = 0;
      let firstError: string | undefined;
      const next: Assets = { ...assets };
      const memberPatches = new Map<string, Partial<TeamMemberSpec>>();
      for (const { key, result } of results) {
        if (!result?.ok) {
          failed++;
          if (result && !firstError) firstError = suggestErrorText(result, t);
          continue;
        }
        const { suggestion } = result;
        const patch: Partial<TeamMemberSpec> = {};
        if (suggestion.tools) patch.tools = suggestion.tools.value;
        if (suggestion.approvalMode) patch.approvalMode = suggestion.approvalMode.value;
        if (Object.keys(patch).length > 0) memberPatches.set(key, patch);
        const skillIds = suggestion.skillIds?.value ?? assetsOf(key).skillIds;
        const mcpServerIds = suggestion.mcpServerIds?.value ?? assetsOf(key).mcpServerIds;
        next[key] = { skillIds: [...skillIds], mcpServerIds: [...mcpServerIds] };
        if (skillIds.length + mcpServerIds.length > 0 || memberPatches.has(key)) set++;
      }
      setAssets(next);
      if (memberPatches.size > 0)
        patchTeam((team) => ({
          ...team,
          members: team.members.map((m) => ({ ...m, ...memberPatches.get(m.key) })),
        }));
      if (failed > 0)
        addToast({
          type: 'error',
          title: t('Suggestions failed for {{n}} members', { n: failed }),
          ...(firstError ? { description: firstError } : {}),
        });
      if (failed < results.length)
        addToast({
          type: set > 0 ? 'success' : 'info',
          title:
            set > 0
              ? t('Configured abilities for {{n}} members', { n: set })
              : t('Current abilities already match the suggestion.'),
        });
    } finally {
      setSuggesting(false);
    }
  };

  const create = async () => {
    if (!picked || !canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const chosen: TeamMemberAssets = Object.fromEntries(
        picked.members
          .map((member) => [member.key, assetsOf(member.key)] as const)
          .filter(([, value]) => value.skillIds.length + value.mcpServerIds.length > 0)
      );
      const result = await window.electronAPI.bots.createTeam({
        team: { ...picked, title: picked.title.trim() },
        workspace: workspace === 'project' ? { kind: 'project', projectId } : { kind: 'chat-home' },
        ...(Object.keys(chosen).length > 0 ? { assets: chosen } : {}),
      });
      if (!result.ok) {
        setError(botErrorText(result.error, chatErrorText(result.error, t), t));
        return;
      }
      const store = useBotsStore.getState();
      for (const bot of result.bots) store.upsertBot(bot);
      store.upsertChat(result.chat);
      store.setView({ kind: 'chat', chatId: result.chat.id });
      void store.loadLatest(result.chat.id);
      onOpenChange(false);
      onCreated?.(result.chat.id);
    } finally {
      setBusy(false);
    }
  };

  const lang = locale === 'zh' ? 'zh' : 'en';
  const nameOf = (key: string) => preview?.team.members.find((m) => m.key === key)?.name ?? key;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Create team from template')}</DialogTitle>
          <DialogDescription>
            {t(
              'Creates the members and their group chat in one go. Members follow the default model; expand a member to set tools, approval, delegation, skills and MCP, or let AI set them.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {!preview ? (
            <>
              <div className="grid grid-cols-3 gap-2.5">
                {templates.map(({ id, data }) => (
                  <button
                    key={id}
                    type="button"
                    disabled={busy}
                    onClick={() => void load({ team: teamSpecOfTemplate(data) })}
                    className="flex flex-col items-start gap-1.5 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    <div className="-space-x-1.5 flex">
                      {data.members.map((member) => (
                        <BotAvatar
                          key={member.key}
                          size="sm"
                          bot={{ name: member.name, avatar: { color: member.color } }}
                        />
                      ))}
                    </div>
                    <span className="font-medium text-sm">{data.title}</span>
                    <span className="text-muted-foreground text-xs">{data.summary}</span>
                  </button>
                ))}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
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
                  if (file) void file.text().then((text) => load({ text }));
                }}
              />
            </>
          ) : (
            <>
              <div>
                <FieldLabel>{t('Group name')}</FieldLabel>
                <Input
                  value={preview.team.title}
                  onChange={(event) => {
                    const title = event.target.value;
                    patchTeam((team) => ({ ...team, title }));
                  }}
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="flex items-baseline gap-2">
                    <span className="text-muted-foreground text-xs">{t('Members')}</span>
                    <span className="text-[11px] text-muted-foreground/70">
                      {t('Uncheck members you do not need; the owner stays')}
                    </span>
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!picked || suggesting || busy}
                    onClick={() => void autoAssets()}
                  >
                    {suggesting ? <Loader2 className="animate-spin" /> : <Sparkles />}
                    {t('AI auto-configure')}
                  </Button>
                </div>
                <div className="space-y-1.5">
                  {preview.team.members.map((member) => {
                    const checked = preview.picked.includes(member.key);
                    const boss = member.key === preview.team.bossKey;
                    const renamed = preview.renamed.find((item) => item.key === member.key);
                    const issue = checked ? nameIssues.get(member.key) : undefined;
                    const targets = member.delegation.canDelegateTo;
                    const shown =
                      targets === 'any'
                        ? []
                        : targets.filter((key) => preview.picked.includes(key));
                    const chosen = assetsOf(member.key);
                    const open = checked && expanded === member.key;
                    return (
                      <div
                        key={member.key}
                        className={cn(
                          'flex items-start gap-2.5 rounded-lg border px-2.5 py-2',
                          !checked && 'opacity-60'
                        )}
                      >
                        <Checkbox
                          className="mt-1.5"
                          checked={checked}
                          disabled={boss}
                          onCheckedChange={(value) =>
                            setPreview({
                              ...preview,
                              picked:
                                value === true
                                  ? [...preview.picked, member.key]
                                  : preview.picked.filter((key) => key !== member.key),
                            })
                          }
                        />
                        <BotAvatar bot={member} size="sm" />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2">
                            <Input
                              className="h-7 w-36"
                              value={member.name}
                              disabled={!checked}
                              onChange={(event) => {
                                const name = event.target.value;
                                patchTeam((team) => ({
                                  ...team,
                                  members: team.members.map((m) =>
                                    m.key === member.key ? { ...m, name } : m
                                  ),
                                }));
                              }}
                            />
                            <span className="truncate text-muted-foreground text-xs">
                              {member.title}
                            </span>
                            {boss && (
                              <span className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                                <Crown className="h-3 w-3" />
                                {t('Owner')}
                              </span>
                            )}
                          </div>
                          <p className="text-muted-foreground text-xs">{member.scope}</p>
                          {renamed && renamed.to === member.name && (
                            <p className="text-warning text-xs">
                              {t('"{{from}}" is taken, renamed to "{{to}}"', renamed)}
                            </p>
                          )}
                          {issue && <p className="text-destructive text-xs">{issue}</p>}
                          <button
                            type="button"
                            disabled={!checked}
                            onClick={() => setExpanded(open ? null : member.key)}
                            className="flex items-start gap-1 text-left text-[11px] text-muted-foreground hover:text-foreground disabled:pointer-events-none"
                          >
                            {open ? (
                              <ChevronDown className="mt-px h-3 w-3 shrink-0" />
                            ) : (
                              <ChevronRight className="mt-px h-3 w-3 shrink-0" />
                            )}
                            <span>
                              {member.tools === 'readonly' ? t('Read-only') : t('All tools')}
                              {' · '}
                              {t(APPROVAL_MODE_META[member.approvalMode].labelKey)}
                              {shown.length > 0 &&
                                ` · ${t('Delegates to {{names}}', {
                                  names: shown.map(nameOf).join(lang === 'zh' ? '、' : ', '),
                                })}`}
                              {' · '}
                              {chosen.skillIds.length + chosen.mcpServerIds.length === 0
                                ? t('No skills or MCP')
                                : t('{{n}} skills · {{m}} MCP', {
                                    n: chosen.skillIds.length,
                                    m: chosen.mcpServerIds.length,
                                  })}
                            </span>
                          </button>
                          {open && (
                            <div className="space-y-3 rounded-lg bg-muted/40 p-2.5">
                              <div>
                                <FieldLabel>{t('Tools')}</FieldLabel>
                                <Segmented
                                  value={member.tools}
                                  options={[
                                    { value: 'all', label: t('All tools') },
                                    { value: 'readonly', label: t('Read-only') },
                                  ]}
                                  onChange={(tools) => patchMember(member.key, { tools })}
                                />
                              </div>
                              <div>
                                <FieldLabel>{t('Approval mode')}</FieldLabel>
                                <ApprovalSelect
                                  value={member.approvalMode}
                                  onChange={(approvalMode) =>
                                    patchMember(member.key, { approvalMode })
                                  }
                                  zIndex={Z_INDEX.DROPDOWN_IN_MODAL}
                                />
                              </div>
                              <TeamRefField
                                label={t('Can delegate to')}
                                value={member.delegation.canDelegateTo}
                                options={preview.picked.filter((key) => key !== member.key)}
                                nameOf={nameOf}
                                onChange={(canDelegateTo) =>
                                  patchMember(member.key, {
                                    delegation: { ...member.delegation, canDelegateTo },
                                  })
                                }
                              />
                              <TeamRefField
                                label={t('Accepts delegation from')}
                                value={member.delegation.acceptFrom}
                                options={preview.picked.filter((key) => key !== member.key)}
                                nameOf={nameOf}
                                onChange={(acceptFrom) =>
                                  patchMember(member.key, {
                                    delegation: { ...member.delegation, acceptFrom },
                                  })
                                }
                              />
                              <AssetPickers
                                value={chosen}
                                onChange={(next) => setMemberAssets(member.key, next)}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {!picked && (
                  <p className="mt-1 text-destructive text-xs">
                    {t('Keep the owner and at least one other member.')}
                  </p>
                )}
              </div>

              <div>
                <FieldLabel>{t('Shared workspace')}</FieldLabel>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setWorkspace('chat-home')}
                    className={cn(
                      'rounded-xl border bg-card p-3 text-left',
                      workspace === 'chat-home' && 'ring-2 ring-info'
                    )}
                  >
                    <div className="font-medium text-sm">{t('Standalone workspace')}</div>
                    <div className="mt-0.5 text-muted-foreground text-xs">
                      {t('A new empty folder for this group, removed with the group')}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setWorkspace('project')}
                    className={cn(
                      'rounded-xl border bg-card p-3 text-left disabled:opacity-50',
                      workspace === 'project' && 'ring-2 ring-info'
                    )}
                  >
                    <div className="font-medium text-sm">{t('Based on a Code project')}</div>
                    <div className="mt-0.5 text-muted-foreground text-xs">
                      {t('Members read and write directly in the project folder')}
                    </div>
                  </button>
                </div>
                {workspace === 'project' && (
                  <BotProjectPicker projectId={projectId} onChange={setProjectId} />
                )}
                <div className="mt-2 flex gap-2 rounded-lg border border-info/40 bg-info/8 px-3 py-2 text-xs">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
                  <span>
                    {t(
                      preview.team.routing.mode === 'smart'
                        ? 'Without @, the best-fit member replies; @ relay limit {{n}}.'
                        : 'Without @, the owner replies; @ relay limit {{n}}.',
                      { n: preview.team.routing.maxHops }
                    )}
                  </span>
                </div>
              </div>
            </>
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
        </DialogPanel>
        <DialogFooter>
          {preview && (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto"
              onClick={() => {
                setPreview(null);
                setError(null);
              }}
            >
              <ArrowLeft />
              {t('Back')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          {preview && (
            <Button size="sm" disabled={!canCreate} onClick={() => void create()}>
              {busy && <Loader2 className="animate-spin" />}
              {t('Create team')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
