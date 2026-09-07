import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export type HashlineIo = {
  readText: (filePath: string) => Promise<string>;
  writeText: (filePath: string, text: string) => Promise<void>;
  readFileText: (filePath: string) => Promise<string | undefined>;
};

function resolvePath(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

export function createHashlineIo(options: {
  cwd: string;
  remote?: {
    readFile: (absolutePath: string) => Promise<Buffer>;
    writeFile: (absolutePath: string, content: string) => Promise<void>;
  };
}): HashlineIo {
  const toAbsolute = (filePath: string) => resolvePath(options.cwd, filePath);
  if (options.remote) {
    const remote = options.remote;
    const readText = async (filePath: string) =>
      (await remote.readFile(toAbsolute(filePath))).toString('utf8');
    return {
      readText,
      writeText: (filePath, text) => remote.writeFile(toAbsolute(filePath), text),
      readFileText: async (filePath) => {
        try {
          return await readText(filePath);
        } catch {
          return undefined;
        }
      },
    };
  }
  const readText = (filePath: string) => readFile(toAbsolute(filePath), 'utf8');
  return {
    readText,
    writeText: (filePath, text) => writeFile(toAbsolute(filePath), text, 'utf8'),
    readFileText: async (filePath) => {
      try {
        return await readText(filePath);
      } catch {
        return undefined;
      }
    },
  };
}
