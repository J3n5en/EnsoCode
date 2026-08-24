import { HardDriveDownload, Sparkles, Trash2 } from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings';
import { LocalAssetImportDialog } from './LocalAssetImportDialog';

export function SkillsSettings() {
  const { t } = useI18n();
  const skills = useSettingsStore((state) => state.skills);
  const updateSkill = useSettingsStore((state) => state.updateSkill);
  const removeSkill = useSettingsStore((state) => state.removeSkill);
  const loadLocalSkills = useSettingsStore((state) => state.loadLocalSkills);
  const setLoadLocalSkills = useSettingsStore((state) => state.setLoadLocalSkills);
  const [importOpen, setImportOpen] = React.useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
        <div>
          <p className="font-medium text-sm">{t('Load local skills')}</p>
          <p className="text-muted-foreground text-xs">
            {t('Let the agent auto-discover skills under .agents/skills and .pi/skills')}
          </p>
        </div>
        <Switch checked={loadLocalSkills} onCheckedChange={setLoadLocalSkills} />
      </div>

      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="font-medium text-lg">{t('Skills')}</h3>
          <p className="text-muted-foreground text-sm">
            {t('Skills registered by reference; files stay in their original location')}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
          <HardDriveDownload className="mr-1.5 h-4 w-4" />
          {t('Import from local apps')}
        </Button>
      </div>

      {skills.length === 0 ? (
        <div className="rounded-md border border-dashed px-3 py-8 text-center">
          <Sparkles className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 font-medium text-sm">{t('No skills yet')}</p>
          <p className="mt-1 text-muted-foreground text-xs">
            {t('Import skills from Claude Code, Codex or Cursor to get started')}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {skills.map((skill) => (
            <div
              key={skill.id}
              className="group flex items-center justify-between gap-3 rounded-md px-3 py-2 transition-colors hover:bg-accent/50"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'shrink-0 font-medium text-sm',
                    !skill.enabled && 'text-muted-foreground line-through'
                  )}
                >
                  {skill.name}
                </span>
                <Badge variant="secondary" className="shrink-0 text-[11px]">
                  {skill.source}
                </Badge>
                <span className="min-w-0 truncate text-muted-foreground text-xs">
                  {skill.description || skill.path}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Switch
                  checked={skill.enabled}
                  onCheckedChange={(enabled) => updateSkill(skill.id, { enabled })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  onClick={() => removeSkill(skill.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <LocalAssetImportDialog kind="skill" open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
