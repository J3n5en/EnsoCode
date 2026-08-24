import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { displayPath } from './skills';

/** 各家 CLI 的全局指令 / 记忆文件名 */
const INSTRUCTION_FILENAMES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'SOUL.md'];

export interface DiscoveredInstruction {
  name: string;
  /** 文件路径；无文件来源为空 */
  path?: string;
  /** 无文件来源（如 CC Switch prompts）的内容 */
  content?: string;
  /** 展示用位置 */
  location: string;
  bytes: number;
  /** 内容哈希，用于跨工具去重（多家常共用同一份内容） */
  hash: string;
}

/** 读取某个工具配置目录下存在的指令文件 */
export function readInstructionFiles(
  dir: string,
  display: (p: string) => string = displayPath
): DiscoveredInstruction[] {
  if (!fs.existsSync(dir)) return [];
  const found: DiscoveredInstruction[] = [];

  for (const filename of INSTRUCTION_FILENAMES) {
    const file = path.join(dir, filename);
    if (!fs.existsSync(file)) continue;
    try {
      const content = fs.readFileSync(file);
      found.push({
        name: filename,
        path: file,
        location: display(file),
        bytes: content.byteLength,
        hash: createHash('sha256').update(content).digest('hex'),
      });
    } catch {
      // 读不到就跳过
    }
  }

  return found;
}
