import { execFile } from 'node:child_process';
import type { ManualInstall } from '@shared/types/updater';
import { releasesBaseUrl } from './updateFeed';

export type AppSignatureKind = 'developer-id' | 'adhoc' | 'unsigned' | 'other' | 'unknown';

/** 解析 `codesign -dv --verbose=2` 输出（写在 stderr） */
export function classifyCodesignOutput(output: string): AppSignatureKind {
  if (/not signed at all/i.test(output)) return 'unsigned';
  if (/^Signature=adhoc$/m.test(output)) return 'adhoc';
  if (/^Authority=Developer ID Application:/m.test(output)) return 'developer-id';
  if (/^Authority=/m.test(output)) return 'other';
  return 'unknown';
}

/**
 * Squirrel.Mac 用当前 app 的 designated requirement 校验新包：ad-hoc / 未签名 / 非 Developer ID 必然装不上正式包。
 * Developer ID 可能同团队能装；判断不了时也放行，交给安装时的签名错误兜底。
 */
export function canAutoInstall(kind: AppSignatureKind): boolean {
  return kind === 'developer-id' || kind === 'unknown';
}

export function inspectAppSignature(bundlePath: string): Promise<AppSignatureKind> {
  return new Promise((resolve) => {
    execFile(
      'codesign',
      ['-dv', '--verbose=2', bundlePath],
      { timeout: 10_000 },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`;
        resolve(
          error && !/not signed at all/i.test(output) ? 'unknown' : classifyCodesignOutput(output)
        );
      }
    );
  });
}

/** Squirrel.Mac（SQRLCodeSignature）签名校验失败的报错 */
export function isCodeSignatureError(message: string): boolean {
  return /did not pass validation|code requirement|code signature|SQRLCodeSignatureErrorDomain/i.test(
    message
  );
}

/** 手动安装入口：对应版本的 Release 页面 + 本机架构的 DMG；没有版本信息退到最新 Release */
export function manualInstallFor(
  info: { version: string; files?: ReadonlyArray<{ url: string }> } | undefined,
  arch: string
): ManualInstall {
  if (!info) return { releaseUrl: `${releasesBaseUrl}/latest` };
  const tag = `v${info.version}`;
  const dmg = info.files?.find(
    (file) => file.url.endsWith('.dmg') && file.url.includes('-arm64') === (arch === 'arm64')
  );
  return {
    version: info.version,
    releaseUrl: `${releasesBaseUrl}/tag/${tag}`,
    ...(dmg
      ? {
          downloadUrl: /^https:\/\//.test(dmg.url)
            ? dmg.url
            : `${releasesBaseUrl}/download/${tag}/${encodeURIComponent(dmg.url)}`,
        }
      : {}),
  };
}
