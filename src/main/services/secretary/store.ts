import { readFileSync, rmSync } from 'node:fs';
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
    if (image) writeAtomic(file, image);
    else rmSync(file, { force: true });
    const imageVersion = image ? (current.avatar.imageVersion ?? 0) + 1 : undefined;
    return this.saveProfile({
      ...current,
      avatar: { color: current.avatar.color, ...(imageVersion ? { imageVersion } : {}) },
      updatedAt: this.now(),
    });
  }

  dispatch(): SecretaryDispatchFile {
    return parseDispatchFile(readJson(this.file('dispatch.json')));
  }

  saveDispatch(file: SecretaryDispatchFile): SecretaryDispatchFile {
    const parsed = parseDispatchFile(file);
    writeJsonAtomic(this.file('dispatch.json'), parsed);
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
