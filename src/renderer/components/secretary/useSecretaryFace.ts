import { secretaryAvatarUrl } from '@shared/localImage';
import { secretaryOwner } from '@shared/secretary/origin';
import type { SecretaryState, SecretarySummary } from '@shared/types/secretary';
import { useI18n } from '@/i18n';
import { useSecretaryStore } from '@/stores/secretary';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';

export interface SecretaryFaceModel {
  name: string;
  color: string;
  image?: string;
}

function toFace(
  name: string | null | undefined,
  avatar: { color: string; imageVersion?: number; imageHash?: string } | null | undefined,
  secretaryId: string | undefined
): SecretaryFaceModel | null {
  if (!avatar) return null;
  const imageVersion = avatar.imageVersion;
  return {
    name: name?.trim() || '·',
    color: avatar.color,
    ...(imageVersion
      ? { image: secretaryAvatarUrl(imageVersion, avatar.imageHash, secretaryId) }
      : {}),
  };
}

/** 清单里还有这个秘书才认。删掉之后状态里可能还留着旧档，不能再拿来当脸 */
function listedSecretary(
  secretaries: readonly SecretarySummary[],
  id: string | null | undefined
): string | null {
  if (!id) return null;
  return secretaries.some((entry) => entry.id === id) ? id : null;
}

/**
 * 这个会话属于哪个秘书：先按隐藏项目，再按会话上记下的派出者，最后按各秘书看板。
 * 都对不上返回 null，调用方回退到当前聚焦的秘书。
 */
function ownerSecretaryId(
  state: {
    secretary: SecretaryState;
    secretaries: readonly SecretarySummary[];
    states: Record<string, SecretaryState>;
  },
  conversationId: string,
  projectId: string | undefined,
  originSecretaryId: string | undefined
): string | null {
  if (projectId) {
    const listed = state.secretaries.find((entry) => entry.projectId === projectId)?.id;
    if (listed) return listed;
    // 清单还没到：只有当前这份状态，项目对得上就是它（单秘书）
    if (
      state.secretaries.length === 0 &&
      state.secretary.projectId === projectId &&
      state.secretary.secretaryId
    ) {
      return state.secretary.secretaryId;
    }
  }
  const fromOrigin = listedSecretary(state.secretaries, originSecretaryId);
  if (fromOrigin) return fromOrigin;
  if (
    state.secretaries.length === 0 &&
    originSecretaryId &&
    (state.states[originSecretaryId] || state.secretary.secretaryId === originSecretaryId)
  ) {
    return originSecretaryId;
  }
  const owned = secretaryOwner(state.states, conversationId)?.secretaryId;
  const fromBoard = listedSecretary(state.secretaries, owned);
  if (fromBoard) return fromBoard;
  if (state.secretaries.length === 0 && owned && state.states[owned]) return owned;
  return null;
}

/** 界面上指代秘书这个角色时用它：用户改的名字优先，没设名字就叫「秘书」 */
export function useSecretaryName(): string {
  const { t } = useI18n();
  return useSecretaryStore((state) => state.secretary.profile?.name.trim()) || t('Secretary');
}

/**
 * 秘书的脸。传了正在渲染的会话，就用那个会话所属秘书的档案；
 * 对不上（删了或未知）再回退当前聚焦的秘书。不传时行为与原来一样。
 */
export function useSecretaryFace(conversationId?: string): SecretaryFaceModel | null {
  const projectId = useSessionsStore((state) =>
    conversationId ? state.conversations[conversationId]?.projectId : undefined
  );
  const originSecretaryId = useSessionsStore((state) =>
    conversationId ? state.conversations[conversationId]?.secretaryOrigin?.secretaryId : undefined
  );
  const ownerId = useSecretaryStore((state) =>
    conversationId ? ownerSecretaryId(state, conversationId, projectId, originSecretaryId) : null
  );
  const owned = useSecretaryStore((state) =>
    ownerId
      ? (state.states[ownerId] ?? (state.focusedId === ownerId ? state.secretary : undefined))
      : undefined
  );
  const summary = useSecretaryStore((state) =>
    ownerId ? state.secretaries.find((entry) => entry.id === ownerId) : undefined
  );
  const focusedProfile = useSecretaryStore((state) =>
    state.secretary.enabled ? state.secretary.profile : null
  );
  const focusedSecretaryId = useSecretaryStore((state) => state.secretary.secretaryId ?? undefined);

  if (ownerId) {
    if (owned && !owned.enabled) return null;
    const avatar = owned?.profile?.avatar ?? (owned ? undefined : summary?.avatar);
    const name = owned?.profile?.name ?? (owned ? undefined : summary?.name);
    if (!avatar) return null;
    return toFace(name, avatar, ownerId);
  }
  if (!focusedProfile) return null;
  return toFace(focusedProfile.name, focusedProfile.avatar, focusedSecretaryId);
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
