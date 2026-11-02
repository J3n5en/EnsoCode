import { LOCAL_IMAGE_SCHEME } from '@shared/localImage';
import { NODE_SETTINGS_SCHEME } from '@shared/nodeSettings';
import { protocol } from 'electron';
import { handleLocalImageRequest } from '../services/localImageProtocol';

/** 必须在 app ready 之前调用（Electron 限制）；全应用只能调一次，节点设置 scheme 一并登记 */
export function registerLocalImageSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_IMAGE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: true,
        stream: true,
      },
    },
    {
      scheme: NODE_SETTINGS_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

/** 在 app ready 之后调用 */
export function registerLocalImageProtocolHandler(): void {
  protocol.handle(LOCAL_IMAGE_SCHEME, (request) =>
    handleLocalImageRequest(request.url, request.headers.get('range'))
  );
}
