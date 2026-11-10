export const SHELL_INTEGRATIONS = ['ensoCommand', 'finderQuickAction'] as const;

export type ShellIntegration = (typeof SHELL_INTEGRATIONS)[number];

export const SHELL_INTEGRATION_MENU_LABELS: Record<ShellIntegration, string> = {
  ensoCommand: "Install 'enso' Command in PATH",
  finderQuickAction: 'Install Finder Quick Action',
};

export const SHELL_INTEGRATION_UNINSTALL_MENU_LABELS: Record<ShellIntegration, string> = {
  ensoCommand: "Uninstall 'enso' Command from PATH",
  finderQuickAction: 'Uninstall Finder Quick Action',
};

export function shellIntegrationMenuLabel(kind: ShellIntegration, installed: boolean): string {
  return (installed ? SHELL_INTEGRATION_UNINSTALL_MENU_LABELS : SHELL_INTEGRATION_MENU_LABELS)[
    kind
  ];
}

export function parseShellIntegration(value: unknown): ShellIntegration | null {
  return SHELL_INTEGRATIONS.find((kind) => kind === value) ?? null;
}
