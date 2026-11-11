import type { ModelProvider } from '@shared/types';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTypeEditDialog } from './AgentTypesSettings';
import { BotSettings } from './BotSettings';
import { API_KIND_LABELS } from './constants';
import { ProviderApiForm } from './ProviderApiForm';
import { ProviderSetupWizard } from './ProviderSetupWizard';
import { ProvidersSettings } from './ProvidersSettings';
import { VirtualModelsSettings } from './VirtualModelsSettings';

const harness = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('@/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(harness.state),
}));
vi.mock('@/stores/oauthCredentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/oauthCredentials')>()),
  useOauthCredentialStore: (selector: (state: unknown) => unknown) =>
    selector({
      snapshot: {
        revision: 0,
        availability: { status: 'ready', authenticatedAccountKeys: new Set() },
      },
    }),
}));
vi.mock('@/components/chat/ModelPicker', () => ({
  MODEL_PICKER_FORM_TRIGGER_CLASS: '',
  ModelPicker: ({ providers }: { providers: ModelProvider[] }) =>
    createElement('div', { 'data-chat-models': providers.map((p) => p.id).join(',') }),
}));
vi.mock('@/components/ui/dialog', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: Wrap,
    DialogPopup: Wrap,
    DialogHeader: Wrap,
    DialogTitle: Wrap,
    DialogDescription: Wrap,
    DialogPanel: Wrap,
    DialogFooter: Wrap,
  };
});
vi.mock('@/components/ui/select', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: ({ items, children }: { items?: unknown; children?: ReactNode }) => (
      <div data-select-items={JSON.stringify(items)}>{children}</div>
    ),
    SelectTrigger: Wrap,
    SelectValue: () => null,
    SelectPopup: Wrap,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
      <div data-option={value}>{children}</div>
    ),
  };
});
vi.mock('@/components/ui/field', () => {
  const Wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Field: Wrap, FieldLabel: Wrap };
});
vi.mock('@/components/oauth/useOauthLoginFlow', () => ({
  useOauthLoginFlow: () => ({ state: { phase: 'idle' }, reset: vi.fn() }),
}));
vi.mock('@/components/oauth/OauthCredentialBootstrap', () => ({
  refreshOauthCredentialState: vi.fn(),
}));
vi.mock('@/components/oauth/OauthLoginStep', () => ({ OauthLoginStep: () => null }));
vi.mock('@/hooks/useAccountUsage', () => ({ useCachedAccountUsage: () => null }));
vi.mock('./OauthProvidersDialog', () => ({
  autoProviderName: vi.fn(),
  OauthProviderAccounts: () => null,
  AccountUsageBlock: () => null,
}));
vi.mock('./ProviderEditDialog', () => ({ ProviderEditDialog: () => null }));
vi.mock('./LocalImportDialog', () => ({ LocalImportDialog: () => null }));
vi.mock('./DefaultModelPicker', () => ({ DefaultModelPicker: () => null }));
vi.mock('./ApprovalReviewerPicker', () => ({ ApprovalReviewerPicker: () => null }));
vi.mock('./TitleSummaryPicker', () => ({ TitleSummaryPicker: () => null }));
vi.mock('./SubagentModelsSettings', () => ({ SubagentModelsSettings: () => null }));
vi.mock('./ProviderModelRow', () => ({ ProviderModelRow: () => null }));
vi.mock('./ListFilterBar', () => ({
  ListFilterBar: () => null,
  useVisibleSelection: () => ({ selectedIds: [], isSelected: () => false }),
}));

const classifier: ModelProvider = {
  id: 'typesafe',
  name: 'TypeSafe',
  catalogId: 'typesafe',
  api: 'typesafe-system-one',
  apiKey: 'test-placeholder',
  baseUrl: 'https://api.typesafe.ai/v1',
  enabled: true,
  models: [{ id: 'jev-latest', enabled: true }],
};
const chat: ModelProvider = {
  ...classifier,
  id: 'chat',
  name: 'Chat provider',
  catalogId: undefined,
  api: 'openai-completions',
  baseUrl: 'https://example.com/v1',
  models: [{ id: 'chat-model', enabled: true }],
};
const classifierConfig = {
  source: 'pi-classifier',
  model: { providerId: classifier.id, modelId: 'jev-latest' },
  timeoutMs: 3000,
};
const note = 'Classification only, not for chat';

beforeEach(() => {
  harness.state = {
    providers: [classifier, chat],
    virtualModels: [],
    defaultModel: null,
    skills: [],
    mcpServers: [],
    botRouteClassifier: classifierConfig,
    botAssistantModel: null,
    botMaxRunningTurns: 1,
  };
});

describe('TypeSafe settings', () => {
  it('labels the dedicated API protocol', () => {
    expect(API_KIND_LABELS['typesafe-system-one']).toBe('TypeSafe System One');
  });

  it('marks TypeSafe as classification-only in the setup wizard', () => {
    expect(renderToStaticMarkup(<ProviderSetupWizard open onOpenChange={vi.fn()} />)).toContain(
      note
    );
  });

  it.each([classifier, { ...classifier, api: 'openai-completions' as const }])(
    'marks new and legacy TypeSafe API forms as classification-only ($api)',
    (provider) => {
      expect(
        renderToStaticMarkup(
          <ProviderApiForm
            initialValue={provider}
            oauth={false}
            onCancel={vi.fn()}
            onSave={vi.fn()}
          />
        )
      ).toContain(note);
    }
  );

  it('does not mark ordinary chat API forms as classification-only', () => {
    expect(
      renderToStaticMarkup(
        <ProviderApiForm initialValue={chat} oauth={false} onCancel={vi.fn()} onSave={vi.fn()} />
      )
    ).not.toContain(note);
  });

  it('marks the provider list entry as classification-only', () => {
    expect(renderToStaticMarkup(<ProvidersSettings />)).toContain(note);
  });

  it.each([{ models: classifier.models }, { models: [] }])(
    'offers TypeSafe for bot classification, but not for helper chat (models: $models)',
    ({ models }) => {
      harness.state.providers = [{ ...classifier, models }, chat];
      const markup = renderToStaticMarkup(<BotSettings />);
      expect(markup).toContain('data-option="typesafe"');
      expect(markup).toContain('data-chat-models="chat"');
      expect(markup).not.toMatch(/data-chat-models="[^"]*typesafe/);
    }
  );

  it('offers TypeSafe for virtual routing, but not primary or fast chat', () => {
    harness.state.virtualModels = [
      {
        id: 'auto',
        name: 'Auto',
        enabled: true,
        primary: { providerId: chat.id, modelId: 'chat-model' },
        fast: { providerId: chat.id, modelId: 'fast-model' },
        fallbacks: [],
        classifier: classifierConfig,
      },
    ];
    const markup = renderToStaticMarkup(<VirtualModelsSettings />);
    expect(markup).toContain('data-option="typesafe"');
    expect(markup).toContain('data-chat-models="chat"');
    expect(markup).not.toMatch(/data-chat-models="[^"]*typesafe/);
  });

  it.each([
    classifier,
    { ...classifier, api: 'openai-completions' as const, catalogId: undefined },
  ])(
    'excludes new and legacy classification-only providers from agent fixed chat options ($api)',
    (provider) => {
      harness.state.providers = [provider, chat];
      const markup = renderToStaticMarkup(
        <AgentTypeEditDialog
          entry={null}
          defaults={{
            name: 'test',
            description: '',
            systemPrompt: '',
            tools: 'all',
            modelMode: 'fixed',
          }}
          onClose={vi.fn()}
        />
      );
      expect(markup).toContain('data-chat-models="chat"');
      expect(markup).not.toContain('typesafe');
    }
  );

  it('does not offer classifier models for a previously saved fixed agent provider', () => {
    const markup = renderToStaticMarkup(
      <AgentTypeEditDialog
        entry={{
          id: 'agent',
          name: 'test',
          description: '',
          systemPrompt: '',
          tools: 'all',
          modelMode: 'fixed',
          providerId: classifier.id,
          modelId: 'jev-latest',
        }}
        onClose={vi.fn()}
      />
    );
    expect(markup).not.toContain('jev-latest');
  });
});
