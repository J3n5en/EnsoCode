import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import { createEnsoCompactHandler } from '../ensoCompact/extension';
import { isAgyModel } from './provider';

/**
 * standard 策略（没挂 Enso 压缩扩展）时，pi 会用会话模型自己总结；agy 会话的桥拒绝这类请求，
 * 原生压缩只会报错。这里给 agy 会话换成 Enso 的本地确定性摘要：agy 的上下文由 agy 自己管，
 * 这次压缩只裁 Enso 自己的记录。其他模型不管，照走 pi 原生。
 */
export const agyCompactGuardExtension = {
  name: 'agy-compact-guard',
  hidden: true,
  factory: (pi: ExtensionAPI) => {
    const local = createEnsoCompactHandler();
    pi.on('session_before_compact', async (event, ctx) => {
      if (!ctx.model || !isAgyModel(ctx.model)) return;
      // 本地摘要做不了（会话太短、切点对不上）就取消：原生那条路必然失败
      return (await local(event, ctx)) ?? { cancel: true };
    });
  },
} satisfies InlineExtension;
