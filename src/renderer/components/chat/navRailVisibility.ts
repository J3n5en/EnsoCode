export type NavRailSide = 'left' | 'right' | 'off';

export function navRailSideOf(value: unknown): NavRailSide {
  return value === 'right' || value === 'off' ? value : 'left';
}

/** 关闭、铺满或不足两轮时不显示。铺满时感应带会盖住贴边的正文。 */
export function navRailEnabled(side: NavRailSide, chatWide: boolean, turnCount: number): boolean {
  return side !== 'off' && !chatWide && turnCount >= 2;
}
