/**
 * vitest 对 TSX 始终用 automatic+development 变换，元素创建走 react/jsx-dev-runtime 的
 * 开发版：每个元素捕获组件栈帧（new Error + defineKeyPropWarningGetter），是渲染密集型
 * 快照测试的第一大开销。测试只观察渲染结果，不靠 DEV 校验，这里按生产版语义实现 jsxDEV
 * （与 jsx-runtime.production 的 jsx 相同的元素构造，去掉栈帧捕获与属性校验）。
 */

import { Fragment } from 'react';
import { jsx as prodJsx } from 'react/jsx-runtime';

export { Fragment };

type AnyProps = Record<string, unknown> & { children?: unknown };

export function jsxDEV(
  type: unknown,
  config: AnyProps,
  maybeKey?: unknown,
  _isStaticChildren?: boolean,
  _source?: unknown,
  _self?: unknown
) {
  // DEV 变换把 children 作为 config.children 传入；生产 jsx 只认 props，语义一致
  return prodJsx(type as never, config as never, maybeKey as never);
}
