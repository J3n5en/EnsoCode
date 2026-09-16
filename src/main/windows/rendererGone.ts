/** clean-exit 是主动销毁。其余 reason（含 Windows 后台 `killed`）都应尝试拉起。 */
export function shouldReloadRenderer(reason: string, goneCount: number): boolean {
  if (reason === 'clean-exit') return false;
  return goneCount <= 3;
}
