import { describe, expect, it } from 'vitest';
import { projectSpaceId } from '../../main/services/memory/types';
import { secretarySpaceId } from './secretarySpace';

describe('secretarySpaceId', () => {
  it('与 Main 的私有空间 id 同格式，否则面板会查不到秘书记忆', () => {
    expect(secretarySpaceId('sec-project')).toBe(projectSpaceId('sec-project'));
  });
});
