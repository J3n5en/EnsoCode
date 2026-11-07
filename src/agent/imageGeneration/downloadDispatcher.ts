import { isIP } from 'node:net';
import { Agent, EnvHttpProxyAgent, Pool } from 'undici';

/** 固定已校验的下载地址；走代理时 CONNECT 也使用该 IP，HTTP Host/TLS SNI 保留原站点。 */
export function imageDownloadDispatcher(url: URL, addresses: readonly string[]) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const lookup = ((
    _host: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void
  ) => {
    const entries = addresses.map((address) => ({ address, family: isIP(address) }));
    if (options.all) callback(null, entries);
    else callback(null, entries[0].address, entries[0].family);
  }) as never;
  const proxy = process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxy) return new Agent({ connect: { lookup } });
  return new EnvHttpProxyAgent({
    httpProxy: proxy,
    httpsProxy: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? proxy,
    noProxy: process.env.NO_PROXY ?? process.env.no_proxy ?? '',
    connect: { lookup },
    requestTls: { servername: isIP(hostname) ? undefined : hostname },
    // 保持 URL/Host 不变供 NO_PROXY 匹配；只改隧道连接目标，阻止代理再次解析目标域名。
    proxyTunnel: true,
    factory(origin, options) {
      // undici 的 factory 把参数声明为 Object；实际是其传给 Pool 的选项。
      const poolOptions = options as Pool.Options;
      const connect = poolOptions.connect;
      if (typeof connect !== 'function') return new Pool(origin, poolOptions);
      return new Pool(origin, {
        ...poolOptions,
        connect(connection, callback) {
          const address = addresses[0];
          const ip = isIP(address) === 6 ? `[${address}]` : address;
          const port = connection.port || (url.protocol === 'https:' ? '443' : '80');
          connect({ ...connection, port, hostname: address, host: `${ip}:${port}` }, callback);
        },
      });
    },
  });
}
