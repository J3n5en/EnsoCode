import { execFile } from 'node:child_process';
import { GITHUB_LOGIN } from '@shared/secretary/githubLogin';

/** 读本机 gh 登录名做建议。失败、超时或不是合法 login 都返回 null，不写任何配置 */
export function suggestGithubLogin(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['api', 'user', '--jq', '.login'],
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 8 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const login = String(stdout ?? '').trim();
        resolve(GITHUB_LOGIN.test(login) ? login : null);
      }
    );
  });
}
