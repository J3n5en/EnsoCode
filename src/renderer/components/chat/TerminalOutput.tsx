import type { ShellFailure } from '@shared/types/agent';
import { defaultDarkTheme, getXtermTheme } from '@/lib/ghosttyTheme';
import { stripAnsi } from '@/lib/terminalText';
import { useSettingsStore } from '@/stores/settings';
import { ShellFailureBar } from './ShellStatus';

/** bash 工具输出：沿用终端配色与等宽字体族，但字号/字重跟随聊天流（text-xs），不套终端那套大字号 */
export function TerminalOutput({
  command,
  output,
  failure,
}: {
  command: string;
  output: string;
  /** 结构化失败分类：底部状态条给出用户下一步与复制命令 */
  failure?: ShellFailure;
}) {
  const terminalTheme = useSettingsStore((s) => s.terminalTheme);
  const fontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const theme = getXtermTheme(terminalTheme) ?? defaultDarkTheme;

  return (
    <div
      data-slot="terminal-output"
      className="px-3 py-2 text-xs leading-relaxed"
      style={{
        backgroundColor: theme.background,
        ['--terminal-bg' as string]: theme.background,
        color: theme.foreground,
        fontFamily,
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
      <ShellFailureBar failure={failure} command={command} />
    </div>
  );
}
