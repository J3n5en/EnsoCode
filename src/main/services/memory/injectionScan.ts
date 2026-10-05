/**
 * 记忆写入安全：长期记忆会被检索回灌进后续会话，写入前先脱敏密钥，
 * 再拒绝带提示注入特征的内容（覆盖指令、伪造角色标签、索要密钥 / 系统提示词、隐藏控制字符）。
 * 规则偏保守但误报可恢复：拒绝信息让模型改写成平铺事实再写。
 */
const INJECTION_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [
    /[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/u,
    'invisible control characters',
  ],
  [
    /\b(ignore|disregard|forget|override)\s+(?:the\s+)?(?:(?:all|any|your|previous|prior|above|earlier|preceding|system|developer|original)\s+)+(instructions?|prompts?|rules|directions|guidelines)\b/i,
    'instruction override',
  ],
  [
    /(忽略|无视|忘记|忘掉|不要理会|跳过)(掉)?\s*(之前|以上|上面|前面|先前|此前|所有|全部|你的|系统).{0,8}(指令|指示|规则|提示词|设定|约束)/,
    'instruction override',
  ],
  [/<\/?(system|developer|assistant|user)\b[^>]*>/i, 'forged role tag'],
  [/<\|(im_start|im_end|endoftext|system)\|>|\[(system|inst)\]/i, 'forged role tag'],
  [/^\s*(?:#{1,3}\s*)?(?:system|developer)\s*[:：]/im, 'forged role tag'],
  [/^\s*(?:系统提示词?|系统指令|开发者指令)\s*[:：]/m, 'forged role tag'],
  [
    /\b(reveal|print|show|repeat|output|dump|leak)\b.{0,40}\b(system prompt|developer (message|prompt)|hidden (instructions?|prompt))/i,
    'prompt exfiltration',
  ],
  [
    /\b(reveal|leak|exfiltrate|dump|disclose)\b.{0,40}\b(api[ _-]?keys?|secrets?|credentials?|passwords?|private keys?|access tokens?)\b/i,
    'secret exfiltration',
  ],
  [
    /\b(send|upload|post|email|forward|share)\b.{0,20}\b(your|all|every|the user'?s)\b.{0,20}\b(api[ _-]?keys?|secrets?|credentials?|passwords?|private keys?|tokens?)\b/i,
    'secret exfiltration',
  ],
  [/(泄露|透露|打印|输出|复述).{0,10}系统提示词?/, 'prompt exfiltration'],
  [
    /(泄露|透露|外传|导出|发送|发给|上传|打印|输出)(出来)?.{0,10}(所有|全部|你的|用户的).{0,6}(密钥|秘钥|api ?key|令牌|token|密码|凭据|凭证)/i,
    'secret exfiltration',
  ],
  [
    /(你的|所有|全部|用户的).{0,6}(密钥|秘钥|api ?key|令牌|token|密码|凭据|凭证).{0,8}(发给|发送|泄露|透露|上传|贴出|外传)/i,
    'secret exfiltration',
  ],
];

export function scanMemoryInjection(text: string): string[] {
  const findings = new Set<string>();
  for (const [pattern, label] of INJECTION_PATTERNS) {
    if (pattern.test(text)) findings.add(label);
  }
  return [...findings];
}
