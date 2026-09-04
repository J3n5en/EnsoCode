export const WINDOWS_LOCAL_SHELLS = ['auto', 'powershell', 'bash'] as const;

export type WindowsLocalShell = (typeof WINDOWS_LOCAL_SHELLS)[number];

export function parseWindowsLocalShell(value: unknown): WindowsLocalShell {
  return typeof value === 'string' && (WINDOWS_LOCAL_SHELLS as readonly string[]).includes(value)
    ? (value as WindowsLocalShell)
    : 'auto';
}
