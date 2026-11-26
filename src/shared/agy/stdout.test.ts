import { describe, expect, it } from 'vitest';
import { AGY_PROTOCOL_ERROR_MESSAGE, AGY_SIGNED_OUT_MESSAGE, classifyStdoutLine } from './stdout';

describe('classifyStdoutLine', () => {
  it('marks a login banner or Google URL as signed-out and drops the line', () => {
    const banner = classifyStdoutLine(
      'Open the following link to authenticate: https://accounts.google.com/o/oauth2/v2/auth?secret=1'
    );
    const url = classifyStdoutLine('https://accounts.google.com/o/oauth2/v2/auth?secret=1');
    expect(banner).toEqual({ kind: 'signed-out' });
    expect(url).toEqual({ kind: 'signed-out' });
    expect(JSON.stringify([banner, url, AGY_SIGNED_OUT_MESSAGE])).not.toContain(
      'accounts.google.com'
    );
  });

  it('turns any other non-JSON line into a fixed protocol error', () => {
    const fault = classifyStdoutLine('debug: token=secret');
    expect(fault).toEqual({ kind: 'protocol-error' });
    expect(AGY_PROTOCOL_ERROR_MESSAGE).not.toContain('token=secret');
  });
});
