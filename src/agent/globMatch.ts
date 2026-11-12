export interface GlobToRegExpOptions {
  /** 识别 `[abc]` / `[!abc]`。默认关闭，write scope 仍把方括号当字面量。 */
  classes?: boolean;
}

/** 极简 glob → RegExp：`**` 任意层级（含空）、`*` 段内任意、`?` 单字符；匹配整段 posix 相对路径 */
export function globToRegExp(glob: string, options?: GlobToRegExpOptions): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[' && options?.classes) {
      const close = glob.indexOf(']', i + 1);
      if (close <= i + 1) {
        out += '\\[';
        continue;
      }
      let body = glob.slice(i + 1, close);
      i = close;
      const negate = body.startsWith('!') || body.startsWith('^');
      if (negate) body = body.slice(1);
      body = body.replace(/\//g, '');
      out += `[${negate ? '^' : ''}${body}${negate ? '/' : ''}]`;
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}
