import { TEMPORAL_YEAR_BOOST } from './constants';

// 时间意图只用正则门，不调 LLM。

export interface TemporalIntent {
  type: 'year' | 'relative';
  /** type=year 时的四位年份 */
  value: string | null;
  confidence: number;
}

// 年、季度/半年/财年、相对时间、中日文关键词
const YEAR_RE = /\b((?:19|20)\d{2})\b/;
const RELATIVE_RES = [
  // 光杆「Q1」也列为时间意图（不要求后跟年份）
  /\b(Q[1-4]|H[12])\b(?:\s*\d{2,4})?|\bFY\s*\d{2,4}\b|\bfiscal\s+year\b/i,
  /\b(before|after|since|until|between|during|within)\s+\w/i,
  /\b(last|next|this|past)\s+(week|month|year|quarter|decade|century)\b/i,
  /\b(recent|latest|current|upcoming)\s+(week|month|year|quarter|changes?|developments?|updates?)\b/i,
  /\byesterday\b|\btomorrow\b|\btoday\b/i,
  /(最近|去年|今年|明年|未来|过去|之前|之后|历史)/,
  // 日文只保留完整词：单字「前」「後」会命中「目前 / 前提 / 后续 / 前后端」等无时间含义的技术表述
  /(来年|過去|以前|以後|歴史|最近|昨日|明日)/,
];

// 正则门没有 LLM 的置信度输出；四位年份几乎不会误判取 1.0，相对词只表明「有时间意图」，
// relative 的匹配分为 0（pass），置信度缺省 0.5。
export function detectTemporalIntent(query: string): TemporalIntent | null {
  const year = YEAR_RE.exec(query);
  if (year) return { type: 'year', value: year[1], confidence: 1 };
  if (RELATIVE_RES.some((re) => re.test(query))) {
    return { type: 'relative', value: null, confidence: 0.5 };
  }
  return null;
}

/**
 * 年份加分：查询明确写了年份且与 event_start 年份一致时加 TEMPORAL_YEAR_BOOST×置信度，否则 0。
 * 新旧由 decay 负责，不再按事件远近加分；相对时间词不加分也不过滤，按时间筛选由调用方显式传 eventDateFrom/To。
 */
export function computeTemporalBoost(eventStart: string | null, intent: TemporalIntent): number {
  if (!eventStart || intent.type !== 'year' || eventStart.slice(0, 4) !== intent.value) return 0;
  return TEMPORAL_YEAR_BOOST * intent.confidence;
}
