import { defaultDarkTheme, getXtermTheme } from '@/lib/ghosttyTheme';
import { useSettingsStore } from '@/stores/settings';

// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要剥掉 ANSI 转义序列
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (text: string): string => text.replace(ANSI_RE, '');

/** bash 工具输出：终端配色 + 终端字体（与设置里外观预览同源） */
export function TerminalOutput({ command, output }: { command: string; output: string }) {
  const terminalTheme = useSettingsStore((s) => s.terminalTheme);
  const fontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const fontSize = useSettingsStore((s) => s.terminalFontSize);
  const fontWeight = useSettingsStore((s) => s.terminalFontWeight);
  const theme = getXtermTheme(terminalTheme) ?? defaultDarkTheme;

  return (
    <div
      className="px-3 py-2"
      style={{
        backgroundColor: theme.background,
        color: theme.foreground,
        fontFamily,
        fontSize,
        fontWeight,
      }}
    >
      <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        <span style={{ color: theme.green }}>$ </span>
        {command}
      </div>
      {output && (
        <pre
          className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]"
          style={{ fontFamily: 'inherit' }}
        >
          {stripAnsi(output)}
        </pre>
      )}
    </div>
  );
}
