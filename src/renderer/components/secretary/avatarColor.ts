export const AVATAR_PRESET_COLORS = [
  '#7c5cff',
  '#2f9e75',
  '#c2553f',
  '#2f7fc2',
  '#b07a1e',
  '#7a4fb5',
] as const;

const COLOR_RE = /^#[0-9a-f]{6}$/iu;

export function normalizeAvatarColor(value: string): string | null {
  const color = value.trim();
  return COLOR_RE.test(color) ? color.toLowerCase() : null;
}

/** 非预设色落在自定义入口上，并标成选中 */
export function avatarColorSelection(color: string | undefined): {
  preset: (typeof AVATAR_PRESET_COLORS)[number] | null;
  customSelected: boolean;
} {
  const normalized = color ? normalizeAvatarColor(color) : null;
  const preset = AVATAR_PRESET_COLORS.find((item) => item === normalized) ?? null;
  return { preset, customSelected: normalized !== null && preset === null };
}

const AVATAR_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const AVATAR_EXT = /\.(png|jpe?g|webp|gif)$/iu;

/** 上传前的类型与大小。gif 不裁切，原字节保存以保住动画。 */
export function secretaryAvatarUploadError(
  file: { type: string; name: string; size: number },
  maxBytes: number
): 'type' | 'size' | null {
  if (file.size <= 0 || file.size > maxBytes) return 'size';
  if (AVATAR_MIME.has(file.type) || AVATAR_EXT.test(file.name)) return null;
  return 'type';
}

/** 声明为 GIF 的文件：读字节核对魔数后跳过裁切 */
export const declaresGif = (file: { type: string; name: string }): boolean =>
  file.type === 'image/gif' || /\.gif$/iu.test(file.name);
