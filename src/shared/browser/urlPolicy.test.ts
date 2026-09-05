import { describe, expect, it } from 'vitest';
import { assertAllowedUrl, isLoopbackHost } from './urlPolicy';

describe('assertAllowedUrl', () => {
  it('accepts http/https and returns the parsed URL', () => {
    expect(assertAllowedUrl('http://127.0.0.1:5173/').href).toBe('http://127.0.0.1:5173/');
    expect(assertAllowedUrl('https://example.com/a?b=1').hostname).toBe('example.com');
  });

  it('adds https when the scheme is missing', () => {
    expect(assertAllowedUrl('example.com/path').href).toBe('https://example.com/path');
    expect(assertAllowedUrl('localhost:3000').href).toBe('http://localhost:3000/');
  });

  it('rejects file, javascript and app-internal schemes with a clear message', () => {
    for (const raw of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'enso://settings',
      'chrome://settings',
      'devtools://x',
      'data:text/html,hi',
      'blob:https://a/b',
    ]) {
      expect(() => assertAllowedUrl(raw)).toThrow(/not allowed/i);
    }
  });

  it('fileRoot 下允许工作区内 file://，仍拒绝逃出与其它协议', () => {
    const fileRoot = '/repo';
    const inside = assertAllowedUrl('file:///repo/docs/INSTALL.md', { fileRoot });
    expect(inside.protocol).toBe('file:');
    expect(inside.pathname.endsWith('/repo/docs/INSTALL.md')).toBe(true);
    expect(() => assertAllowedUrl('file:///etc/passwd', { fileRoot })).toThrow(/not allowed/i);
    expect(() => assertAllowedUrl('file:///repo/../etc/passwd', { fileRoot })).toThrow(
      /not allowed/i
    );
    expect(() => assertAllowedUrl('javascript:alert(1)', { fileRoot })).toThrow(/not allowed/i);
    expect(assertAllowedUrl('https://example.com', { fileRoot }).hostname).toBe('example.com');
  });

  it('拒绝非绝对根、编码分隔符、NUL 和远端 file 主机', () => {
    for (const [raw, fileRoot] of [
      ['file:///repo/a', ''],
      ['file:///repo/a', 'repo'],
      ['file:///repo/a%00.html', '/repo'],
      ['file:///repo/a%2fb', '/repo'],
      ['file:///repo/a%5cb', '/repo'],
      ['file://remote/repo/a', '/repo'],
    ])
      expect(() => assertAllowedUrl(raw, { fileRoot })).toThrow(/not allowed/i);
  });

  it('支持 Windows 工作区路径及编码文件名', () => {
    expect(assertAllowedUrl('file:///C:/repo/a%20b.html', { fileRoot: 'C:\\repo' }).protocol).toBe(
      'file:'
    );
    expect(() => assertAllowedUrl('file:///D:/repo/a', { fileRoot: 'C:\\repo' })).toThrow();
  });

  it('rejects garbage', () => {
    expect(() => assertAllowedUrl('')).toThrow();
    expect(() => assertAllowedUrl('   ')).toThrow();
    expect(() => assertAllowedUrl('http://')).toThrow();
    expect(() => assertAllowedUrl('http://user:pw@host/')).toThrow(/credentials/i);
  });
});

describe('isLoopbackHost', () => {
  it('matches localhost, 127.x and ::1', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('app.localhost')).toBe(true);
  });
  it('does not match public hosts', () => {
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);
  });
});
