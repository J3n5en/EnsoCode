import type { ExtensionPluginManifest } from './manifest';

/** 用户同意时记录的授权范围；更新时与新清单比较，变大须重新同意 */
export interface PluginGrant {
  permissions: string[];
  fsRead: string[];
  fsWrite: string[];
  netDomains: string[];
  mcp: { name: string; command: string; args: string[]; envKeys: string[] }[];
  mcpTools: string[];
  renderer: boolean;
  env: string[];
  interop: string[];
  /** 拦截型订阅的事件；只通知的不计 */
  intercepts: string[];
  resident: boolean;
  /** 有主题带 CSS：可以改变应用任意界面 */
  styles: boolean;
}

export function grantOf(manifest: ExtensionPluginManifest): PluginGrant {
  return {
    permissions: [...manifest.permissions].sort(),
    fsRead: [...manifest.fs.read].sort(),
    fsWrite: [...manifest.fs.write].sort(),
    netDomains: [...manifest.net.domains].sort(),
    mcp: manifest.contributes.mcpServers.map((s) => ({
      name: s.name,
      command: s.command,
      args: [...s.args],
      envKeys: Object.keys(s.env).sort(),
    })),
    mcpTools: [...manifest.mcp.tools].sort(),
    renderer: manifest.renderer !== undefined,
    env: [...manifest.env].sort(),
    interop: [...manifest.interop.call].sort(),
    intercepts: manifest.contributes.events
      .filter((e) => e.mode === 'intercept')
      .map((e) => e.event)
      .sort(),
    resident: manifest.resident,
    styles: manifest.contributes.themes.some((theme) => theme.css !== undefined),
  };
}

const covered = (path: string, scope: string[]) =>
  scope.some((root) => root === '.' || path === root || path.startsWith(`${root}/`));

export function grantExpands(previous: PluginGrant, next: PluginGrant): boolean {
  if (next.permissions.some((p) => !previous.permissions.includes(p))) return true;
  if (next.fsRead.some((p) => !covered(p, previous.fsRead))) return true;
  if (next.fsWrite.some((p) => !covered(p, previous.fsWrite))) return true;
  if (next.netDomains.some((d) => !previous.netDomains.includes(d))) return true;
  const key = (s: PluginGrant['mcp'][number]) =>
    JSON.stringify([s.name, s.command, s.args, s.envKeys]);
  const known = new Set(previous.mcp.map(key));
  if (next.mcp.some((s) => !known.has(key(s)))) return true;
  const grew = (a: string[], b: string[]) => b.some((x) => !a.includes(x));
  if (grew(previous.mcpTools, next.mcpTools)) return true;
  if (grew(previous.env, next.env)) return true;
  if (grew(previous.interop, next.interop)) return true;
  if (grew(previous.intercepts, next.intercepts)) return true;
  if (next.resident && !previous.resident) return true;
  if (next.styles && !previous.styles) return true;
  return next.renderer && !previous.renderer;
}
