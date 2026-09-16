const SSE_EOF = new Uint8Array([10, 10]);

/**
 * openai-node 的 SSE 解码只在空行时吐事件；网关若在最后一条 `data:` 后直接关连接，
 * `response.completed` 会被丢掉，pi 就报 stream ended before a terminal response event。
 * 在 EOF 补 `\n\n`，空帧会被忽略，未闭合的末帧会被刷出。
 */
export function withSseEofFlush(fetchFn: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.body || !contentType.toLowerCase().includes('text/event-stream')) {
      return response;
    }
    return new Response(appendSseEof(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function appendSseEof(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (value && value.byteLength > 0) controller.enqueue(value);
        if (done) {
          controller.enqueue(SSE_EOF);
          controller.close();
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
