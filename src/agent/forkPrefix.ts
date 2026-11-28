import type { Message } from '@earendil-works/pi-ai';

/**
 * seed_context="fork" 子代理的请求改写：前缀位置换回注入时的原样消息。
 *
 * 子会话 transcript 以父会话某次请求的消息原样起头（含承载系统提示与工具声明的 system 消息）。
 * 子会话自己的 context 变换（历史图片降占位、旧工具结果裁剪等）会改动这段前缀，缓存就对不上；
 * 每次请求把它换回原样字节。子代理自己的提示段与工具增减由 pi 以 system 增量补在前缀之后：
 * 支持中途 system / 工具变更的 provider 原生渲染在前缀后，缓存命中；不支持的折叠回请求头，
 * 只丢缓存，提示与工具仍然正确。
 * 前缀对不上（子会话已压缩等）时原样返回，不改写。
 */
export function withForkPrefix<T extends { messages: Message[] }>(
  prefix: readonly Message[] | undefined,
  context: T
): T {
  if (!prefix || prefix.length === 0) return context;
  const { messages } = context;
  if (messages.length < prefix.length) return context;
  for (let i = 0; i < prefix.length; i++) {
    if (messages[i].role !== prefix[i].role || messages[i].timestamp !== prefix[i].timestamp) {
      return context;
    }
  }
  return { ...context, messages: [...prefix, ...messages.slice(prefix.length)] };
}
