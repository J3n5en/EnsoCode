import { beforeEach, describe, expect, it } from 'vitest';
import { closeSettings, setSettingsCategory, useAppViewStore } from '@/stores/appView';
import { bindMainSettingsRequests, type MainSettingsRequestSource } from './mainSettingsRequests';

function source(requests: unknown[]) {
  let push: (() => void) | null = null;
  const api: MainSettingsRequestSource = {
    consumeSettingsDeepLink: async () =>
      (requests.shift() ?? null) as Awaited<
        ReturnType<MainSettingsRequestSource['consumeSettingsDeepLink']>
      >,
    onSettingsDeepLink: (listener) => {
      push = listener;
      return () => {
        push = null;
      };
    },
  };
  return { api, push: () => push?.(), requests };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const route = () => useAppViewStore.getState().settings;

beforeEach(() => {
  closeSettings();
  setSettingsCategory('general');
});

describe('主进程转来的「打开设置」落到内嵌设置的分区和行', () => {
  it('主窗口新建（托盘、enso:// 冷启动）：挂载时拉到请求，打开对应分区并定位到行', async () => {
    const { api } = source([{ link: { category: 'secretary', rowId: 'secretary.dispatchLimit' } }]);
    bindMainSettingsRequests(api);
    await flush();
    expect(route()?.link).toEqual({ category: 'secretary', rowId: 'secretary.dispatchLimit' });
  });

  it('已挂载：收到推送再拉取；插件安装地址一并带上', async () => {
    const { api, push, requests } = source([]);
    bindMainSettingsRequests(api);
    await flush();
    expect(route()).toBeNull();
    requests.push({
      link: { category: 'plugins', rowId: 'plugins.enso', pluginInstallUrl: 'https://x.dev/p.zip' },
    });
    push();
    await flush();
    expect(route()?.link).toEqual({
      category: 'plugins',
      rowId: 'plugins.enso',
      pluginInstallUrl: 'https://x.dev/p.zip',
    });
  });

  it('不带深链（托盘 / 应用菜单「设置…」）：进设置并回到上次的分区', async () => {
    setSettingsCategory('logs');
    const { api } = source([{ link: null }]);
    bindMainSettingsRequests(api);
    await flush();
    expect(route()).toEqual({ link: null, linkSeq: 0 });
    expect(useAppViewStore.getState().lastCategory).toBe('logs');
  });

  it('没有请求：留在工作区', async () => {
    const { api, push } = source([]);
    bindMainSettingsRequests(api);
    push();
    await flush();
    expect(route()).toBeNull();
  });

  it('被挪走的旧行深链落到新分区', async () => {
    const { api } = source([
      { link: { category: 'general', rowId: 'general.autoArchiveIdleDays' } },
    ]);
    bindMainSettingsRequests(api);
    await flush();
    expect(route()?.link?.category).toBe('runtime');
  });
});
