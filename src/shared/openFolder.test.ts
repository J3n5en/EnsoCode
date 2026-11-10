import { describe, expect, it } from 'vitest';
import { openFolderPathsFromArgv } from './openFolder';

describe('openFolderPathsFromArgv', () => {
  it('reads a single --open-folder token', () => {
    expect(openFolderPathsFromArgv(['EnsoCode.exe', '--open-folder=C:\\Work\\app'])).toEqual([
      'C:\\Work\\app',
    ]);
  });

  it('keeps spaces that belong to the path', () => {
    expect(openFolderPathsFromArgv(['--open-folder=C:\\Program Files\\Enso Code'])).toEqual([
      'C:\\Program Files\\Enso Code',
    ]);
  });

  it('turns the Windows drive-root quote artifact C:" into C:\\', () => {
    expect(openFolderPathsFromArgv(['--open-folder=C:"'])).toEqual(['C:\\']);
  });

  it('turns a bare drive letter into a root path', () => {
    expect(openFolderPathsFromArgv(['--open-folder=D:'])).toEqual(['D:\\']);
  });

  it('ignores other arguments, including an enso link, Chromium switches, and a split flag', () => {
    expect(
      openFolderPathsFromArgv([
        'EnsoCode.exe',
        '--disable-gpu',
        'enso://install-plugin?url=https://example.com',
        '--open-folder',
        'C:\\should-not-open',
        '--open-folder=C:\\Work\\app',
        '--allow-file-access-from-files',
      ])
    ).toEqual(['C:\\Work\\app']);
  });

  it('dedupes paths and keeps the first occurrence', () => {
    expect(
      openFolderPathsFromArgv([
        '--open-folder=C:\\b',
        '--open-folder=C:\\a',
        '--open-folder=C:\\b',
        '--open-folder=D:',
        '--open-folder=D:\\',
      ])
    ).toEqual(['C:\\b', 'C:\\a', 'D:\\']);
  });

  it('drops an empty value after trim and quote stripping', () => {
    expect(
      openFolderPathsFromArgv([
        '--open-folder=',
        '--open-folder=   ',
        '--open-folder="',
        '--open-folder=  C:\\Work\\app  ',
      ])
    ).toEqual(['C:\\Work\\app']);
  });
});
