export interface TodoDispatchFacts {
  projectPath: string;
  branch: string | null;
  /** 这次会不会真的建独立 worktree。档案禁止时不要在说明里假装已经隔离 */
  worktree: boolean;
  /** 派发时指定的检出；缺省是项目目录 */
  checkout?: string;
  /** 指定的基线 ref；缺省是检出当前 HEAD */
  baseRef?: string;
  /** 指定的新分支名；缺省由应用自动命名 */
  newBranch?: string;
}

/** 正文里已经交代了隔离和禁止推送，就当成完整派发说明，不再套一层 */
export function hasDispatchBrief(text: string): boolean {
  return /worktree/i.test(text) && /不推送|不要推送|do not push/i.test(text);
}

export function todoDispatchPrompt(
  todoText: string,
  explicitPrompt: string | undefined,
  facts: TodoDispatchFacts
): string {
  const body = (explicitPrompt?.trim() || todoText).trim();
  if (hasDispatchBrief(body)) return body;
  const base = facts.baseRef ?? facts.branch;
  const from = base ? `基于 ${base}` : '基于当前检出';
  const into = facts.newBranch ? `新建 ${facts.newBranch} 分支` : '新建分支';
  const branchLine = facts.worktree
    ? `${from}${base ? ' ' : ''}${into}，在已建好的独立 worktree 里工作，不要改主检出。`
    : facts.branch
      ? `当前分支是 ${facts.branch}。在这个项目里工作，不要改其他检出。`
      : '在这个项目里工作，不要改其他检出。';
  return [
    `项目：${facts.projectPath}`,
    ...(facts.checkout && facts.checkout !== facts.projectPath
      ? [`基线取自检出：${facts.checkout}`]
      : []),
    branchLine,
    '不推送，也不合并。',
    '跑验收时用独立目录和空闲端口，不要占用已经在跑的实例。',
    '',
    body,
  ].join('\n');
}
