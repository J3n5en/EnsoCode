import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildColdSearchDocs, queryWorkspaceSearchIndex } from './workspaceSearchIndex';

const sessionDir = '/tmp/enso-sessions';

describe('workspaceSearchIndex', () => {
  it('只收录权威 sessionFile 且落在 sessionDir 内的条目', () => {
    const docs = buildColdSearchDocs(
      [
        {
          conversationId: 'c1',
          projectId: 'p1',
          projectName: 'alpha',
          sessionFile: path.join(sessionDir, 'ok.jsonl'),
        },
        {
          conversationId: 'escape',
          projectId: 'p1',
          projectName: 'alpha',
          sessionFile: path.join(sessionDir, '..', 'escape.jsonl'),
        },
        {
          conversationId: 'missing',
          projectId: 'p1',
          projectName: 'alpha',
          sessionFile: path.join(sessionDir, 'gone.jsonl'),
        },
      ],
      [
        {
          path: path.join(sessionDir, 'ok.jsonl'),
          firstMessage: 'hello permission gate',
          allMessagesText: 'hello permission gate later body',
          modified: new Date(2000),
        },
        {
          path: path.join(sessionDir, '..', 'escape.jsonl'),
          firstMessage: 'escaped',
          allMessagesText: 'escaped',
          modified: new Date(3000),
        },
      ],
      sessionDir
    );
    expect(docs.map((doc) => doc.conversationId)).toEqual(['c1']);
    expect(
      docs[0]?.fields.some((field) => field.field === 'body' && field.text.includes('permission'))
    ).toBe(true);
  });

  it('查询走同一套 searchWorkspace，未知会话不会读盘', async () => {
    const hits = await queryWorkspaceSearchIndex(
      { query: 'permission', currentProjectId: 'p1', scope: 'project' },
      {
        sessionDir,
        listReady: () => [
          {
            conversationId: 'c1',
            projectId: 'p1',
            projectName: 'alpha',
            sessionFile: path.join(sessionDir, 'ok.jsonl'),
          },
        ],
        listSessions: async () => [
          {
            path: path.join(sessionDir, 'ok.jsonl'),
            firstMessage: 'hello',
            allMessagesText: 'talked about permission gate',
            modified: new Date(1),
          },
        ],
      }
    );
    expect(hits.map((hit) => hit.conversationId)).toEqual(['c1']);
  });
});
