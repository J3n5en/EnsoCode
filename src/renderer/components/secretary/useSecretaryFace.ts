import { secretaryAvatarUrl } from '@shared/localImage';
import { useI18n } from '@/i18n';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

export interface SecretaryFaceModel {
  name: string;
  color: string;
  image?: string;
}

/** 界面上指代秘书这个角色时用它：用户改的名字优先，没设名字就叫「秘书」 */
export function useSecretaryName(): string {
  const { t } = useI18n();
  return useSecretaryStore((state) => state.secretary.profile?.name.trim()) || t('Secretary');
}

/** 秘书自己的脸，和当前打开的是不是秘书会话无关 */
export function useSecretaryFace(): SecretaryFaceModel | null {
  const profile = useSecretaryStore((state) =>
    state.secretary.enabled ? state.secretary.profile : null
  );
  if (!profile) return null;
  const imageVersion = profile.avatar.imageVersion;
  return {
    name: profile.name.trim() || '·',
    color: profile.avatar.color,
    ...(imageVersion ? { image: secretaryAvatarUrl(imageVersion, profile.avatar.imageHash) } : {}),
  };
}

function useDisplayedProjectKind(): string | undefined {
  const projectId = useSessionsStore((state) => {
    const active = state.activeId ? state.conversations[state.activeId] : undefined;
    if (!active) return undefined;
    const displayed = active.activeTabId
      ? (state.conversations[active.activeTabId] ?? active)
      : active;
    return displayed.projectId;
  });
  return useSettingsStore((state) =>
    projectId ? state.projects.find((project) => project.id === projectId)?.kind : undefined
  );
}

/** 当前打开的会话属于秘书项目。档案还没建好时也算。 */
export function useIsSecretaryChat(): boolean {
  return useDisplayedProjectKind() === 'secretary';
}

/** 当前聊天属于秘书项目时，回复头和空会话用这张脸 */
export function useSecretaryChatSpeaker(): SecretaryFaceModel | null {
  const face = useSecretaryFace();
  return useIsSecretaryChat() ? face : null;
}
