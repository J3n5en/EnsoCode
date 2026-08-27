import path from 'node:path';
import type { ModelRuntime as ModelRuntimeType } from '@earendil-works/pi-coding-agent';
import type { OauthLoginEvent, OauthProviderInfo } from '@shared/types';
import { IPC_CHANNELS } from '@shared/types';
import { app, shell, type WebContents } from 'electron';

// pi-ai 不在依赖树顶层，auth 交互类型从 ModelRuntime.login 签名结构化提取
type AuthInteraction = Parameters<ModelRuntimeType['login']>[2];
type AuthPrompt = Parameters<AuthInteraction['prompt']>[0];

// 与 agent worker 共用同一 auth.json（pi CredentialStore 文件锁保证跨进程互斥），
// 登录/退出在 Main 完成后，worker 侧请求时经 getAuth 直接读到新凭证
let runtimePromise: Promise<ModelRuntimeType> | null = null;

function getRuntime(): Promise<ModelRuntimeType> {
  runtimePromise ??= (async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    return ModelRuntime.create({
      authPath: path.join(app.getPath('userData'), 'agent', 'pi-agent', 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
  })();
  return runtimePromise;
}

export async function listOauthProviders(): Promise<OauthProviderInfo[]> {
  const runtime = await getRuntime();
  // 登录态以 auth.json 为准（listCredentials 读文件），兼容外部（pi CLI）写入
  const credentials = await runtime.listCredentials();
  const loggedIn = new Set(
    credentials.filter((info) => info.type === 'oauth').map((info) => info.providerId)
  );
  return runtime
    .getProviders()
    .filter((provider) => provider.auth.oauth)
    .map((provider) => ({
      id: provider.id,
      name: provider.auth.oauth?.name || provider.name,
      loginLabel: provider.auth.oauth?.loginLabel,
      loggedIn: loggedIn.has(provider.id),
      models: provider.getModels().map((model) => model.id),
    }));
}

interface ActiveLogin {
  abort: AbortController;
  pendingPrompts: Map<string, { resolve: (value: string) => void; reject: (err: Error) => void }>;
}

// 同一时刻只允许一个进行中的登录流程
let activeLogin: ActiveLogin | null = null;

export async function startOauthLogin(providerId: string, sender: WebContents): Promise<void> {
  const emit = (event: OauthLoginEvent) => {
    if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.OAUTH_LOGIN_EVENT, event);
  };
  if (activeLogin) {
    emit({ type: 'error', message: 'login already in progress' });
    return;
  }

  const abort = new AbortController();
  const pendingPrompts: ActiveLogin['pendingPrompts'] = new Map();
  activeLogin = { abort, pendingPrompts };

  try {
    const runtime = await getRuntime();
    await runtime.login(providerId, 'oauth', {
      signal: abort.signal,
      notify: (event) => {
        switch (event.type) {
          case 'info':
            emit({ type: 'info', message: event.message });
            break;
          case 'auth_url':
            void shell.openExternal(event.url);
            emit({ type: 'auth_url', url: event.url, instructions: event.instructions });
            break;
          case 'device_code':
            void shell.openExternal(event.verificationUri);
            emit({
              type: 'device_code',
              userCode: event.userCode,
              verificationUri: event.verificationUri,
            });
            break;
          case 'progress':
            emit({ type: 'progress', message: event.message });
            break;
        }
      },
      prompt: (prompt: AuthPrompt) => {
        const requestId = crypto.randomUUID();
        return new Promise<string>((resolve, reject) => {
          pendingPrompts.set(requestId, { resolve, reject });
          // 流程侧可能在带外事件（如回调服务器命中）后取消这个 prompt
          prompt.signal?.addEventListener('abort', () => {
            if (pendingPrompts.delete(requestId)) {
              emit({ type: 'prompt-cancel', requestId });
              reject(new Error('prompt aborted'));
            }
          });
          emit({
            type: 'prompt',
            prompt: {
              requestId,
              type: prompt.type,
              message: prompt.message,
              placeholder: 'placeholder' in prompt ? prompt.placeholder : undefined,
              options:
                prompt.type === 'select'
                  ? prompt.options.map((option) => ({ ...option }))
                  : undefined,
            },
          });
        });
      },
    });
    emit({ type: 'done', providerId });
  } catch (error) {
    emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    for (const pending of pendingPrompts.values()) pending.reject(new Error('login finished'));
    pendingPrompts.clear();
    activeLogin = null;
  }
}

export function respondOauthPrompt(requestId: string, value: string): void {
  const pending = activeLogin?.pendingPrompts.get(requestId);
  if (!pending) return;
  activeLogin?.pendingPrompts.delete(requestId);
  pending.resolve(value);
}

export function cancelOauthLogin(): void {
  activeLogin?.abort.abort();
}

export async function oauthLogout(providerId: string): Promise<void> {
  const runtime = await getRuntime();
  await runtime.logout(providerId);
}
