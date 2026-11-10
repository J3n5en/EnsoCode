export const SHELL_INTEGRATIONS = ['ensoCommand', 'finderQuickAction'] as const;

export type ShellIntegration = (typeof SHELL_INTEGRATIONS)[number];

export const SHELL_INTEGRATION_MENU_LABELS: Record<ShellIntegration, string> = {
  ensoCommand: "Install 'enso' Command in PATH",
  finderQuickAction: 'Install Finder Quick Action',
};

export function parseShellIntegration(value: unknown): ShellIntegration | null {
  return SHELL_INTEGRATIONS.find((kind) => kind === value) ?? null;
}
