import { HardDriveDownload, Sparkles, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { SettingsButton, SettingsPage, SettingsRow, SettingsSection, SettingsSwitch } from './kit';
import { ListFilterBar, matchesFilter, useVisibleSelection } from './ListFilterBar';
import { LocalAssetImportDialog } from './LocalAssetImportDialog';
import { NewSessionBadge } from './NewSessionBadge';
import {
  enabledOccupancyTotal,
  OccupancyEnabledTotal,
  OccupancyMark,
  useOccupancyRows,
} from './OccupancyMark';

export function SkillsSettings() {
  const { t } = useI18n();
  const skills = useSettingsStore((state) => state.skills);
  const updateSkill = useSettingsStore((state) => state.updateSkill);
  const setSkillsEnabled = useSettingsStore((state) => state.setSkillsEnabled);
  const removeSkill = useSettingsStore((state) => state.removeSkill);
  const loadLocalSkills = useSettingsStore((state) => state.loadLocalSkills);
  const setLoadLocalSkills = useSettingsStore((state) => state.setLoadLocalSkills);
  const loadHarnessAssets = useSettingsStore((state) => state.loadHarnessAssets);
  const setLoadHarnessAssets = useSettingsStore((state) => state.setLoadHarnessAssets);
  const [importOpen, setImportOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const visible = skills.filter((skill) =>
    matchesFilter(query, [skill.name, skill.source, skill.description, skill.path])
  );
  const visibleIds = visible.map((skill) => skill.id);
  const selection = useVisibleSelection(visibleIds);
  const enabledCount = skills.filter((skill) => skill.enabled).length;
  const skillIds = skills.map((skill) => skill.id);
  const occupancy = useOccupancyRows(skillIds, (ids) =>
    window.electronAPI.assets.skillOccupancy(ids)
  );
  const enabledTokens = enabledOccupancyTotal(
    skills.filter((skill) => skill.enabled).map((skill) => skill.id),
    occupancy.rows
  );

  return (
    <SettingsPage
      rowId="skills.root"
      title={
        <>
          {t('Skills')}
          {skills.length > 0 && (
            <span className="font-normal text-muted-foreground text-xs">
              {t('{{enabled}}/{{total}} enabled', {
                enabled: enabledCount,
                total: skills.length,
              })}
              <OccupancyEnabledTotal tokens={enabledTokens} />
            </span>
          )}
        </>
      }
      badge={
        <NewSessionBadge
          note={t(
            'The / menu updates right away, but open sessions keep the skills they loaded. Start a new session to load the change.'
          )}
        />
      }
      description={t('Skills registered by reference; files stay in their original location')}
      actions={
        <SettingsButton onClick={() => setImportOpen(true)}>
          <HardDriveDownload className="mr-1.5 h-4 w-4" />
          {t('Import from local apps')}
        </SettingsButton>
      }
    >
      <SettingsSection>
        <SettingsRow
          label={t('Load local skills')}
          description={t('Let the agent auto-discover skills under .agents/skills and .pi/skills')}
        >
          <SettingsSwitch checked={loadLocalSkills} onCheckedChange={setLoadLocalSkills} />
        </SettingsRow>
        <SettingsRow
          label={t('Load project harness assets')}
          description={t(
            'Also load skills from .claude/.codex/.cursor and rule files (.cursorrules, .cursor/rules, .claude/rules) in the project'
          )}
        >
          <SettingsSwitch checked={loadHarnessAssets} onCheckedChange={setLoadHarnessAssets} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection>
        {skills.length === 0 ? (
          <div className="border-border border-b py-8 text-center">
            <Sparkles className="mx-auto h-5 w-5 text-muted-foreground" />
            <p className="mt-3 font-medium text-sm">{t('No skills yet')}</p>
            <p className="mt-1 text-muted-foreground text-xs">
              {t('Import skills from Claude Code, Codex or Cursor to get started')}
            </p>
          </div>
        ) : (
          <>
            <ListFilterBar
              query={query}
              onQueryChange={setQuery}
              placeholder={t('Filter skills...')}
              allSelected={selection.allSelected}
              someSelected={selection.someSelected}
              onToggleSelectAll={selection.toggleAll}
              onEnable={() => setSkillsEnabled(selection.selectedIds, true)}
              onDisable={() => setSkillsEnabled(selection.selectedIds, false)}
              selectDisabled={visible.length === 0}
              actionDisabled={selection.selectedIds.length === 0}
            />
            {visible.length === 0 ? (
              <p className="border-border border-b py-6 text-center text-muted-foreground text-xs">
                {t('No results')}
              </p>
            ) : (
              visible.map((skill) => (
                <SettingsRow
                  key={skill.id}
                  rowId={`skills.${skill.id}`}
                  leading={
                    <Checkbox
                      checked={selection.isSelected(skill.id)}
                      onCheckedChange={(checked) => selection.toggleOne(skill.id, checked)}
                    />
                  }
                  label={
                    <span className={cn(!skill.enabled && 'text-muted-foreground line-through')}>
                      {skill.name}
                    </span>
                  }
                  description={
                    <span className="block truncate">{skill.description || skill.path}</span>
                  }
                  status={
                    <>
                      <Badge variant="secondary" className="shrink-0 text-[11px]">
                        {skill.source}
                      </Badge>
                      <OccupancyMark
                        row={occupancy.rows[skill.id]}
                        pending={occupancy.pending && !occupancy.rows[skill.id]}
                      />
                    </>
                  }
                >
                  <SettingsSwitch
                    checked={skill.enabled}
                    onCheckedChange={(enabled) => updateSkill(skill.id, { enabled })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    aria-label={t('Delete')}
                    onClick={() => removeSkill(skill.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </SettingsRow>
              ))
            )}
          </>
        )}
      </SettingsSection>

      <LocalAssetImportDialog kind="skill" open={importOpen} onOpenChange={setImportOpen} />
    </SettingsPage>
  );
}
