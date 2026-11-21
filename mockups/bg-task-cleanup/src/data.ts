// 全部是假数据：命令、端口、会话名均为示例
import type { Task } from './ui';

export const IPROXY: Task = {
  command: 'iproxy 2222 22',
  duration: '2h 14m',
  status: 'kept',
  keptBy: 'agent',
  reason: '用户的 iproxy，SSH 仍在用',
};
export const DEV: Task = {
  command: 'pnpm dev --port 5173',
  duration: '1h 05m',
  status: 'idle',
  idle: '42 分钟',
};
export const VITEST: Task = {
  command: 'pnpm vitest --watch src/auth',
  duration: '8s',
  status: 'running',
};
export const POSTGRES: Task = {
  command: 'docker compose up postgres',
  duration: '3h 20m',
  status: 'kept',
  keptBy: 'user',
  reason: '10:20',
};
export const NGROK: Task = {
  command: 'ngrok http 8080',
  duration: '2h 41m',
  status: 'idle',
  idle: '1 小时 12 分钟',
};
export const TSC: Task = { command: 'pnpm tsc --watch', duration: '25m', status: 'running' };
export const HTTP: Task = {
  command: 'python3 -m http.server 8000',
  duration: '2h 30m',
  status: 'idle',
  idle: '2 小时 03 分钟',
};

export interface SessionGroup {
  title: string;
  project: string;
  note?: string;
  tasks: Task[];
}

export const GROUPS: SessionGroup[] = [
  { title: '重构登录页', project: 'web-console', note: '当前会话', tasks: [IPROXY, DEV, VITEST] },
  { title: '接入支付回调', project: 'api-server', tasks: [POSTGRES, NGROK] },
  { title: '升级依赖版本', project: 'web-console', tasks: [TSC] },
  { title: '修复 CI 缓存', project: 'infra', note: '未打开', tasks: [HTTP] },
];

export const DEV_TAIL = `  VITE v6.2.0  ready in 412 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
14:07:52 [vite] hmr update /src/pages/Login.tsx
14:08:31 [vite] hmr update /src/pages/Login.tsx (x2)`;

export const IPROXY_TAIL = `Creating listening port 2222 for device port 22
waiting for connection
New connection for 2222->22, fd = 5
Requesting connection to USB device handle 3 (serial: 0000XXXX-XXXXXXXXXXXX), port 22
waiting for connection`;
