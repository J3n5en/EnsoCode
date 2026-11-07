import { FormData as UndiciFormData, fetch as undiciFetch } from 'undici';

/** 与 worker 的 undici dispatcher 配套；Node 内置 fetch 可能仍使用旧版 handler 协议。 */
export const imageFetch = (url: string, init: RequestInit): Promise<Response> => {
  const options = { ...init } as Parameters<typeof undiciFetch>[1];
  // undici 8 不把 Node 内置旧版 FormData 识别为 multipart，会发成 "[object FormData]"。
  if (init.body instanceof FormData) {
    const form = new UndiciFormData();
    for (const [name, value] of init.body.entries()) {
      if (typeof value === 'string') form.append(name, value);
      else form.append(name, value, value.name);
    }
    if (options) options.body = form;
  }
  return undiciFetch(url, options) as unknown as Promise<Response>;
};
