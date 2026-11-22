/**
 * userData 根路径的轻量来源：Main 用 Electron app 注入，记忆服务子进程由
 * memoryRoot 反推注入（子进程没有 app）。让模型/路径类模块不再依赖 @platform，
 * 这样它们既能跑在 Main 也能跑进记忆服务的独立 bundle。
 */
import { dirname } from 'node:path';

let userDataDir: string | null = null;

export function setUserDataDir(dir: string | null): void {
  userDataDir = dir;
}

/** 调用方必须先经 initMemoryService（服务侧）或 Main 启动时注入；测试可用 setUserDataDir */
export function userDataPath(): string {
  if (userDataDir) return userDataDir;
  // 兜底：dev 脚本/测试环境可直接给环境变量；生产必须显式注入，否则暴露接线缺失
  const envDir = process.env.ENSO_USER_DATA;
  if (envDir) {
    userDataDir = envDir;
    return envDir;
  }
  throw new Error('userDataPath(): userData dir not injected');
}

/** memoryRoot 默认布局下的反推（memory root 是 userData/memory） */
export function inferUserDataFromMemoryRoot(memoryRoot: string): string {
  return dirname(memoryRoot);
}
