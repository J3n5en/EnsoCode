import type { ModelApiKind } from './llm';

/** pi 内置 OAuth provider 的展示信息（Main 汇总，Renderer 只读） */
export interface OauthProviderInfo {
  id: string;
  name: string;
  /** 登录入口文案，如 "Sign in with SuperGrok or X Premium" */
  loginLabel?: string;
  loggedIn: boolean;
  models: { id: string; api: ModelApiKind }[];
}

/** 登录流程中需要用户输入的 prompt（Main → Renderer，经 respond 回传） */
export interface OauthLoginPrompt {
  requestId: string;
  type: 'text' | 'secret' | 'select' | 'manual_code';
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

/** 登录流程事件（Main → Renderer 单向推送） */
export type OauthLoginEvent =
  | { type: 'info'; message: string }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string }
  | { type: 'progress'; message: string }
  | { type: 'prompt'; prompt: OauthLoginPrompt }
  | { type: 'prompt-cancel'; requestId: string }
  | { type: 'done'; providerId: string }
  | { type: 'error'; message: string };
