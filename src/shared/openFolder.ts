const OPEN_FOLDER_FLAG = '--open-folder=';

export function openFolderPathsFromArgv(argv: readonly string[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const token of argv) {
    if (!token.startsWith(OPEN_FOLDER_FLAG)) continue;
    // Windows 把 `"--open-folder=C:\"` 解析成 `C:"`，先去掉这个引号再补盘符根。
    let value = token.slice(OPEN_FOLDER_FLAG.length).trim();
    if (value.endsWith('"')) value = value.slice(0, -1);
    if (/^[a-zA-Z]:$/.test(value)) value = `${value}\\`;
    if (!value || seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
  }
  return paths;
}
