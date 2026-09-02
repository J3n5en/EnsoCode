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
