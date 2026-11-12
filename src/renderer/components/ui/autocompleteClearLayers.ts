export interface ClearLayerState {
  hasValue: boolean;
  mirrorText: string;
  /** 清除动画还没结束就被程序化改了值（如点「浏览」选了新目录），需要放弃这段动画 */
  superseded: boolean;
}

/** 镜像层与 has-value 的下一个状态：有值时代显示文字，真实输入文字保持透明 */
export function nextClearLayerState(input: {
  value: string;
  mirrorText: string;
  clearing: boolean;
}): ClearLayerState {
  const hasValue = input.value.length > 0;
  const mirrorText = hasValue ? input.value.replace(/ /g, '\u00a0') : '';
  const superseded = input.clearing && hasValue && mirrorText !== input.mirrorText;
  return { hasValue, mirrorText, superseded };
}
