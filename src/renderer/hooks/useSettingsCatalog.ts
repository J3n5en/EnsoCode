import { buildSettingsCatalog, type SettingsSearchEntry } from '@shared/searchAnything';
import { useMemo } from 'react';
import { useSettingsStore } from '@/stores/settings';

const NO_SSH: readonly { id: string; name: string }[] = [];

export function useSettingsCatalog(
  sshConnections: readonly { id: string; name: string }[] = NO_SSH
): SettingsSearchEntry[] {
  const providers = useSettingsStore((state) => state.providers);
  const skills = useSettingsStore((state) => state.skills);
  const mcpServers = useSettingsStore((state) => state.mcpServers);
  const instructions = useSettingsStore((state) => state.instructions);

  return useMemo(
    () =>
      buildSettingsCatalog({
        providers: providers.map((item) => ({ id: item.id, name: item.name })),
        skills: skills.map((item) => ({ id: item.id, name: item.name })),
        mcpServers: mcpServers.map((item) => ({ id: item.id, name: item.name })),
        instructions: instructions.map((item) => ({ id: item.id, name: item.name })),
        sshConnections: [...sshConnections],
      }),
    [instructions, mcpServers, providers, skills, sshConnections]
  );
}
