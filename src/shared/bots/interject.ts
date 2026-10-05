const SUPPLEMENT = {
  zh: '这是同一件事的补充，保留原目标，把它并进这一轮的结果；不要单独回一句「收到」。只有明确说换掉或取消才改目标。\n补充内容：\n',
  en: 'This adds to the same request. Keep the original goal and fold it into this turn\'s result; do not reply with a standalone "got it". Only change the goal if explicitly told to replace or cancel it.\nAddition:\n',
} as const;

/** 人类消息插进正在运行的轮次：前置补充说明，让成员并进当前目标而不是另起一事 */
export function wrapInterjection(text: string, lang: 'zh' | 'en'): string {
  return `${SUPPLEMENT[lang]}${text}`;
}

/** 展示与草稿还原时去掉开头的补充说明 */
export function stripInterjection(text: string): string {
  for (const prefix of Object.values(SUPPLEMENT))
    if (text.startsWith(prefix)) return text.slice(prefix.length);
  return text;
}
