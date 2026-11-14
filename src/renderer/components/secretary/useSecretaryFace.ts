import { secretaryAvatarUrl } from '@shared/localImage';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

export interface SecretaryFaceModel {
  name: string;
  color: string;
  image?: string;
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
    ...(imageVersion ? { image: secretaryAvatarUrl(imageVersion) } : {}),
  };
}

/** 当前聊天属于秘书项目时，回复头和空会话用这张脸 */
export function useSecretaryChatSpeaker(): SecretaryFaceModel | null {
  const face = useSecretaryFace();
  const projectId = useSessionsStore((state) => {
    const active = state.activeId ? state.conversations[state.activeId] : undefined;
    if (!active) return undefined;
    const displayed = active.activeTabId
      ? (state.conversations[active.activeTabId] ?? active)
      : active;
    return displayed.projectId;
  });
  const kind = useSettingsStore((state) =>
    projectId ? state.projects.find((project) => project.id === projectId)?.kind : undefined
  );
  return kind === 'secretary' ? face : null;
}
