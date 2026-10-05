import { redactSecrets } from './distill';
import { scanMemoryInjection } from './injectionScan';
import { MemoryValidationError } from './types';

export { scanMemoryInjection };

export interface SanitizedMemoryWrite {
  title: string | null;
  content: string;
  redacted: boolean;
}

/** 注入命中抛 unsafe_content（不落库）；否则返回脱敏后的标题 / 正文 */
export function sanitizeMemoryWrite(input: {
  title: string | null;
  content: string;
}): SanitizedMemoryWrite {
  const findings = scanMemoryInjection(`${input.title ?? ''}\n${input.content}`);
  if (findings.length > 0) {
    throw new MemoryValidationError(
      'unsafe_content',
      `Refused to write memory: it looks like a prompt-injection attempt (${findings.join(', ')}). ` +
        'Memories are replayed into future sessions, so they must not contain instructions aimed at the model, role tags or requests for secrets. ' +
        'Rewrite it as a plain factual note, or drop it.'
    );
  }
  const title = input.title === null ? null : redactSecrets(input.title);
  const content = redactSecrets(input.content);
  return { title, content, redacted: title !== input.title || content !== input.content };
}
