export type SlashSubcommand = { name: string; aliases: string[]; description: string };

const GOAL: SlashSubcommand[] = [
  { name: 'pause', aliases: [], description: 'Pause the current session goal' },
  { name: 'resume', aliases: [], description: 'Resume a paused session goal' },
  { name: 'clear', aliases: [], description: 'Clear the session goal' },
];

const BY_SLASH: Record<string, SlashSubcommand[]> = {
  '/goal': GOAL,
};

export function slashSubcommandQuery(slash: string | null, editorText: string): string | null {
  if (!slash) return null;
  const trimmed = editorText.trimStart();
  if (!trimmed) return '';
  const space = trimmed.search(/\s/);
  if (space >= 0) return null;
  return trimmed;
}

export function filterSlashSubcommands(slash: string | null, query: string): SlashSubcommand[] {
  if (!slash) return [];
  const rows = BY_SLASH[slash] ?? [];
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (row) =>
      row.name.toLowerCase().startsWith(needle) ||
      row.aliases.some((alias) => alias.toLowerCase().startsWith(needle))
  );
}
