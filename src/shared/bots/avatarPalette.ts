const FALLBACK = '#64748b';
const HEX = /^#[0-9a-f]{6}$/i;

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function toHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return `#${[r, g, b]
    .map((v) =>
      Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/** 成员色派生的 5 色调色板（boring-avatars 用），首色即成员色 */
export function avatarPalette(color: string): string[] {
  const base = typeof color === 'string' && HEX.test(color) ? color.toLowerCase() : FALLBACK;
  const [h, s0] = toHsl(base);
  const s = Math.max(s0, 0.35);
  const at = (dh: number, l: number) => toHex((h + dh + 360) % 360, s, l);
  return [base, at(35, 0.78), at(-35, 0.32), at(180, 0.62), at(90, 0.9)];
}
