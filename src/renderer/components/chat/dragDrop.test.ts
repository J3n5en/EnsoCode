import { describe, expect, it } from 'vitest';
import {
  COMPOSER_DROP_ID,
  type DragPayload,
  PINNED_DROP_ID,
  pinnedChatDragId,
  routeDrop,
} from './dragDrop';

const project: DragPayload = {
  type: 'project',
  projectId: 'p1',
  path: '/repo/checkout-service',
  name: 'checkout-service',
};

const chat: DragPayload = {
  type: 'chat',
  conversationId: 'c1',
  title: '给购物车加活动\n污染行',
  sessionFile: '/sessions/c1.jsonl',
  pinned: false,
};

describe('routeDrop: 项目', () => {
  it('项目拖到另一项目 → 重排', () => {
    expect(routeDrop(project, 'project:p2', undefined)).toEqual({
      kind: 'reorder-projects',
      activeId: 'p1',
      overId: 'p2',
    });
  });

  it('项目拖到自身 → 不动', () => {
    expect(routeDrop(project, 'project:p1', undefined)).toBeNull();
  });

  it('项目拖到 Composer → 插入项目根绝对路径的 file mention', () => {
    expect(routeDrop(project, COMPOSER_DROP_ID, undefined)).toEqual({
      kind: 'insert-file-mention',
      path: '/repo/checkout-service',
      label: 'checkout-service',
    });
  });

  it('项目拖到 Pinned 区 → 不动', () => {
    expect(routeDrop(project, PINNED_DROP_ID, undefined)).toBeNull();
  });
});

describe('routeDrop: 会话', () => {
  it('会话拖到 Composer → 插入 chat mention,标题取首行', () => {
    expect(routeDrop(chat, COMPOSER_DROP_ID, undefined)).toEqual({
      kind: 'insert-chat-mention',
      conversationId: 'c1',
      label: '给购物车加活动',
      sessionFile: '/sessions/c1.jsonl',
    });
  });

  it('空标题回落 Untitled chat', () => {
    expect(routeDrop({ ...chat, title: '  ' }, COMPOSER_DROP_ID, undefined)).toMatchObject({
      label: 'Untitled chat',
    });
  });

  it('无 sessionFile 的会话拖到 Composer → 不插入', () => {
    expect(routeDrop({ ...chat, sessionFile: undefined }, COMPOSER_DROP_ID, undefined)).toBeNull();
  });

  it('拖入当前会话自身的输入框 → 不插入', () => {
    expect(routeDrop(chat, COMPOSER_DROP_ID, 'c1')).toBeNull();
  });

  it('会话拖到 Pinned 区 → 置顶', () => {
    expect(routeDrop(chat, PINNED_DROP_ID, undefined)).toEqual({
      kind: 'pin-conversation',
      conversationId: 'c1',
    });
  });

  it('已置顶会话拖到 Pinned 区 → 不重复切换', () => {
    expect(routeDrop({ ...chat, pinned: true }, PINNED_DROP_ID, undefined)).toBeNull();
  });

  it('会话拖到项目行 → 不动(不支持跨项目移动)', () => {
    expect(routeDrop(chat, 'project:p2', undefined)).toBeNull();
  });
});

describe('routeDrop: Pinned 组内排序', () => {
  it('置顶会话拖到另一置顶行 → 组内重排', () => {
    expect(routeDrop({ ...chat, pinned: true }, pinnedChatDragId('c9'), undefined)).toEqual({
      kind: 'reorder-pinned',
      activeId: 'c1',
      overId: 'c9',
    });
  });

  it('拖到自身 → 不动', () => {
    expect(routeDrop({ ...chat, pinned: true }, pinnedChatDragId('c1'), undefined)).toBeNull();
  });

  it('未置顶会话拖到置顶行上 → 视为拖入置顶区(置顶)', () => {
    expect(routeDrop(chat, pinnedChatDragId('c9'), undefined)).toEqual({
      kind: 'pin-conversation',
      conversationId: 'c1',
    });
  });

  it('项目拖到置顶行 → 不动', () => {
    expect(routeDrop(project, pinnedChatDragId('c9'), undefined)).toBeNull();
  });
});

describe('routeDrop: 工作区文件', () => {
  const file: DragPayload = {
    type: 'workspace-file',
    relativePath: 'src/a.ts',
    name: 'a.ts',
  };

  it('拖到 Composer → file mention',
    () => {
      expect(routeDrop(file, COMPOSER_DROP_ID, undefined)).toEqual({
        kind: 'insert-file-mention',
        path: 'src/a.ts',
        label: 'a.ts',
      });
    }
  );

  it('拖到项目行 → 不动', () => {
    expect(routeDrop(file, 'project:p1', undefined)).toBeNull();
  });
});

describe('routeDrop: 无落点', () => {
  it('overId 为 null → 不动', () => {
    expect(routeDrop(chat, null, undefined)).toBeNull();
  });
});
