import { useEffect, useState } from 'react';
import { useOauthCredentialStore } from '@/stores/oauthCredentials';

const emptyEmails: ReadonlyMap<string, string> = new Map();
interface EmailSnapshot {
  revision: number;
  emails: ReadonlyMap<string, string>;
}
let cache: { revision: number; request: Promise<EmailSnapshot>; data?: EmailSnapshot } | undefined;

function loadEmails(revision: number): Promise<EmailSnapshot> {
  if (cache?.revision === revision) return cache.request;
  const request = window.electronAPI.providers
    .listOauth()
    .then((infos) => {
      const emails = new Map<string, string>();
      for (const info of infos) {
        for (const account of info.accounts) {
          if (typeof account.email !== 'string') continue;
          let email = '';
          for (const ch of account.email) {
            const code = ch.codePointAt(0) ?? 0;
            if (code >= 0x20 && code !== 0x7f) email += ch;
          }
          email = email.trim();
          if (email) emails.set(account.key, email);
        }
      }
      return { revision, emails };
    })
    .catch((error) => {
      console.error('Failed to load OAuth account metadata', error);
      return { revision, emails: emptyEmails };
    });
  const current = { revision, request, data: undefined as EmailSnapshot | undefined };
  cache = current;
  void request.then((data) => {
    if (cache === current) current.data = data;
  });
  return request;
}

/**
 * 只读取现有 listOauth 的脱敏展示元数据，不读凭据，也不写入设置或会话历史。
 * 同一凭证 revision 的时间线行共用一次查询；刷新时立即隐藏旧邮箱，忽略过期或卸载后的响应。
 *
 * Read only sanitized display metadata from listOauth, never credentials, settings or session history.
 * Timeline rows share one query per credential revision; hide stale emails immediately and ignore obsolete or unmounted replies.
 */
export function useOauthAccountEmails(): ReadonlyMap<string, string> {
  const revision = useOauthCredentialStore((state) => state.snapshot.revision);
  const [snapshot, setSnapshot] = useState<EmailSnapshot | undefined>(() =>
    cache?.revision === revision ? cache.data : undefined
  );
  useEffect(() => {
    let cancelled = false;
    void loadEmails(revision).then((data) => {
      if (!cancelled) setSnapshot(data);
    });
    return () => {
      cancelled = true;
    };
  }, [revision]);
  return snapshot?.revision === revision ? snapshot.emails : emptyEmails;
}
