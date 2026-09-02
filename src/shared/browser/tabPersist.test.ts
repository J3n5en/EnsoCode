import { describe, expect, it } from 'vitest';
import { parsePersistedBrowserTabs, serializePersistedBrowserTabs } from './tabPersist';

describe('parsePersistedBrowserTabs', () => {
  it('keeps http(s) entries and drops junk', () => {
    const parsed = parsePersistedBrowserTabs({
      'conv-1': { url: 'https://example.com/', title: 'Example Domain' },
      'conv-2': { url: 'http://127.0.0.1:8877/', title: '' },
      bad: { url: 'file:///etc/passwd', title: 'x' },
      also: { url: 'https://ok.com' },
      nope: null,
    });
    expect(parsed).toEqual({
      'conv-1': { url: 'https://example.com/', title: 'Example Domain' },
      'conv-2': { url: 'http://127.0.0.1:8877/', title: '' },
      also: { url: 'https://ok.com', title: '' },
    });
  });

  it('roundtrips', () => {
    const data = { a: { url: 'https://a.test/', title: 'A' } };
    expect(parsePersistedBrowserTabs(JSON.parse(serializePersistedBrowserTabs(data)))).toEqual(
      data
    );
  });
});
