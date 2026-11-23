import { createHash } from 'node:crypto';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseDispatchFile,
  parseProfile,
  parseSchedules,
  parseTodos,
} from '../../../shared/secretary/parse';
import type {
  SecretaryDispatchFile,
  SecretaryProfile,
  SecretarySchedule,
  SecretaryTodo,
} from '../../../shared/types/secretary';
import { readJson, writeAtomic, writeJsonAtomic } from '../bots/files';
import { prepareSecretaryAvatarWrite, readableSecretaryAvatar } from './avatarFile';

/** 头像字节的短指纹：同一张图同一个值，换图必变，用作 URL 的缓存失效参数 */
export function imageHash(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 8);
}

function readAvatarBytes(file: string): Uint8Array | null {
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

/**
 * dispatch.json 动辄近 1MB，秘书每个流式事件要读好几次：按文件签名复用解析结果。
 * 写入都是原子改名（inode 必变），别处改写也能按签名认出来。
 */
const dispatchCache = new Map<string, { sig: string; file: SecretaryDispatchFile }>();

function fileSignature(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** userData/secretary/{profile.json, persona.md, avatar.png, dispatch.json, todos.json, schedules.json} */
export class SecretaryStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  profile(): SecretaryProfile | null {
    return parseProfile(readJson(this.file('profile.json')));
  }

  saveProfile(profile: SecretaryProfile): SecretaryProfile {
    const parsed = parseProfile(profile);
    if (!parsed) throw new Error('Invalid secretary profile');
    writeJsonAtomic(this.file('profile.json'), parsed);
    return parsed;
  }

  readPersona(): string {
    try {
      return readFileSync(this.file('persona.md'), 'utf8');
    } catch {
      return '';
    }
  }

  writePersona(persona: string): void {
    writeAtomic(this.file('persona.md'), persona);
  }

  /** 重来：档案、人设与头像一起清掉；会话、待办与私有记忆由调用方决定 */
  clearProfile(): void {
    for (const name of ['profile.json', 'persona.md', 'avatar.png']) {
      rmSync(this.file(name), { force: true });
    }
  }

  /** 只在档案标记有图时返回 avatar.png 路径 */
  avatarPath(): string | null {
    if (!this.profile()?.avatar.imageVersion) return null;
    return readableSecretaryAvatar(this.dir);
  }

  /** 写入 / 删除头像图片（字节已由调用方校验）；没有档案时不接受 */
  setAvatar(image: Uint8Array | null): SecretaryProfile | null {
    const current = this.profile();
    if (!current) return null;
    const file = prepareSecretaryAvatarWrite(this.dir);
    if (!file) return null;
    const previous = readAvatarBytes(file);
    if (image) writeAtomic(file, image);
    else rmSync(file, { force: true });
    const avatar = image
      ? {
          color: current.avatar.color,
          imageVersion: (current.avatar.imageVersion ?? 0) + 1,
          imageHash: imageHash(image),
        }
      : { color: current.avatar.color };
    try {
      return this.saveProfile({
        ...current,
        avatar,
        updatedAt: this.now(),
      });
    } catch (error) {
      // 档案没落盘就回滚图片：字节换了、版本没换时 URL 不变，界面会一直显示旧图
      if (previous) writeAtomic(file, previous);
      else rmSync(file, { force: true });
      throw error;
    }
  }

  dispatch(): SecretaryDispatchFile {
    return structuredClone(this.dispatchView());
  }

  /** 只读视图，与缓存共用同一个对象：调用方不得修改，要改用 dispatch() */
  dispatchView(): Readonly<SecretaryDispatchFile> {
    const path = this.file('dispatch.json');
    const sig = fileSignature(path);
    const hit = dispatchCache.get(path);
    if (sig && hit?.sig === sig) return hit.file;
    const file = parseDispatchFile(readJson(path));
    if (sig) dispatchCache.set(path, { sig, file });
    else dispatchCache.delete(path);
    return file;
  }

  saveDispatch(file: SecretaryDispatchFile): SecretaryDispatchFile {
    const parsed = parseDispatchFile(file);
    const path = this.file('dispatch.json');
    writeJsonAtomic(path, parsed);
    const sig = fileSignature(path);
    // 按 JSON 往返存：与重新读盘得到的完全一致（undefined 字段一并去掉）
    if (sig) dispatchCache.set(path, { sig, file: JSON.parse(JSON.stringify(parsed)) });
    else dispatchCache.delete(path);
    return parsed;
  }

  todos(): SecretaryTodo[] {
    return parseTodos(readJson(this.file('todos.json')));
  }

  saveTodos(todos: SecretaryTodo[]): SecretaryTodo[] {
    const parsed = parseTodos(todos);
    writeJsonAtomic(this.file('todos.json'), parsed);
    return parsed;
  }

  schedules(): SecretarySchedule[] {
    return parseSchedules(readJson(this.file('schedules.json')));
  }

  saveSchedules(schedules: SecretarySchedule[]): SecretarySchedule[] {
    const parsed = parseSchedules(schedules);
    writeJsonAtomic(this.file('schedules.json'), parsed);
    return parsed;
  }

  private file(name: string): string {
    return join(this.dir, name);
  }
}
