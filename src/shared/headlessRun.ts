/** `enso-server run` 置位。worker 与插件宿主据此关掉目录刷新和更新检查。 */
export const ENSO_HEADLESS_RUN_ENV = 'ENSO_HEADLESS_RUN';

export function isHeadlessRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENSO_HEADLESS_RUN_ENV] === '1';
}
