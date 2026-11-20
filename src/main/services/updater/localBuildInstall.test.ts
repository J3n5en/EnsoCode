import { describe, expect, it } from 'vitest';
import {
  canAutoInstall,
  classifyCodesignOutput,
  isCodeSignatureError,
  manualInstallFor,
} from './localBuildInstall';

const DEVELOPER_ID = `Executable=/x/EnsoCode.app/Contents/MacOS/EnsoCode
Identifier=com.j3n5en.enso-code
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=505 flags=0x10000(runtime) hashes=4+7 location=embedded
Signature size=9031
Authority=Developer ID Application: Someone (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=ABCDE12345`;

const ADHOC = `Executable=/x/EnsoCode.app/Contents/MacOS/EnsoCode
Identifier=com.j3n5en.enso-code
CodeDirectory v=20400 size=505 flags=0x2(adhoc) hashes=4+7 location=embedded
Signature=adhoc
TeamIdentifier=not set`;

const APPLE_DEVELOPMENT = `Identifier=com.j3n5en.enso-code
Authority=Apple Development: someone@example.com (XYZ)
Authority=Apple Worldwide Developer Relations Certification Authority
Authority=Apple Root CA
TeamIdentifier=XYZ1234567`;

describe('本地构建签名识别', () => {
  it('按 codesign -dv 输出区分签名类型', () => {
    expect(classifyCodesignOutput(DEVELOPER_ID)).toBe('developer-id');
    expect(classifyCodesignOutput(ADHOC)).toBe('adhoc');
    expect(classifyCodesignOutput('/x/EnsoCode.app: code object is not signed at all')).toBe(
      'unsigned'
    );
    expect(classifyCodesignOutput(APPLE_DEVELOPMENT)).toBe('other');
    expect(classifyCodesignOutput('')).toBe('unknown');
  });

  it('只有 Developer ID（或无法判断）时才尝试自动安装', () => {
    expect(canAutoInstall('developer-id')).toBe(true);
    expect(canAutoInstall('unknown')).toBe(true);
    expect(canAutoInstall('adhoc')).toBe(false);
    expect(canAutoInstall('unsigned')).toBe(false);
    expect(canAutoInstall('other')).toBe(false);
  });

  it('识别 Squirrel.Mac 的签名校验失败，不误判网络错误', () => {
    expect(
      isCodeSignatureError(
        'Code signature at URL file:///private/var/folders/x/EnsoCode.app/ did not pass validation: code failed to satisfy specified code requirement(s)'
      )
    ).toBe(true);
    expect(isCodeSignatureError('Could not get code signature for running application')).toBe(true);
    expect(isCodeSignatureError('net::ERR_INTERNET_DISCONNECTED')).toBe(false);
    expect(isCodeSignatureError('HttpError: 404 Not Found')).toBe(false);
  });
});

describe('手动安装入口', () => {
  const info = {
    version: '0.3.12',
    files: [
      { url: 'EnsoCode-0.3.12-arm64-mac.zip' },
      { url: 'EnsoCode-0.3.12-arm64.dmg' },
      { url: 'EnsoCode-0.3.12-mac.zip' },
      { url: 'EnsoCode-0.3.12.dmg' },
    ],
  };
  const base = 'https://github.com/J3n5en/EnsoCode/releases';

  it('Release 页面 + 对应架构的 DMG', () => {
    expect(manualInstallFor(info, 'arm64')).toEqual({
      version: '0.3.12',
      releaseUrl: `${base}/tag/v0.3.12`,
      downloadUrl: `${base}/download/v0.3.12/EnsoCode-0.3.12-arm64.dmg`,
    });
    expect(manualInstallFor(info, 'x64').downloadUrl).toBe(
      `${base}/download/v0.3.12/EnsoCode-0.3.12.dmg`
    );
  });

  it('没有 DMG 只给 Release 页面；没有版本信息退到最新 Release', () => {
    expect(manualInstallFor({ version: '0.4.0-beta.1', files: [] }, 'arm64')).toEqual({
      version: '0.4.0-beta.1',
      releaseUrl: `${base}/tag/v0.4.0-beta.1`,
    });
    expect(manualInstallFor(undefined, 'arm64')).toEqual({ releaseUrl: `${base}/latest` });
  });
});
