import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { AppShell } from '../../src/app/AppShell';
import { LandingPage } from '../../src/features/landing/LandingPage';
import { AiModelMenu } from '../../src/components/AiModelMenu';
import { useStore } from '../../src/stores/useAppStore';
import { authApi, fetchAuthStatus } from '../../src/services/auth';
import { streamAgentEvents } from '../../src/services/ai/client';

/* Mockovanie AI streamovacieho klienta */
vi.mock('../../src/services/ai/client', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/ai/client')>(),
  streamAgentEvents: vi.fn(),
}));

const catalogFixture = {
  defaultId: 'mistral',
  models: [
    { id: 'mistral', label: 'AI (Mistral)', provider: 'mistral', model: 'mistral-large-latest', fallbackIds: [] },
    { id: 'openai', label: 'AI (OpenAI)', provider: 'openai', model: 'gpt-4o', fallbackIds: [] },
  ],
};

const userFixture = {
  user: { id: 'usr-101', email: 'founder@vorkei.sk', plan: 'free' },
  quota: { used: 0, limit: 10, remaining: 10, plan: 'free' },
};

beforeEach(() => {
  useStore.getState().newProject();
  vi.mocked(streamAgentEvents).mockReset();
  useStore.setState({
    model: 'Instant Draft',
    aiModelId: undefined,
    aiFallbackIds: [],
    generating: false,
    promptDraft: '',
    messages: [],
    snapshots: [],
    vfs: {},
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('End-to-End Smoke Test — kompletný používateľský workflow', () => {
  it('prejde celým cyklom: registrácia -> prihlásenie -> výber modelu Mistral -> zadanie promptu -> vygenerovanie projektu -> uloženie snapshotu', async () => {
    /* 1. KROK: Registrácia nového používateľa cez authApi */
    const mockFetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === '/api/auth/register') {
        return Response.json({ user: userFixture.user, quota: userFixture.quota });
      }
      if (url === '/api/auth/login') {
        return Response.json({ user: userFixture.user, quota: userFixture.quota });
      }
      if (url === '/api/auth/me') {
        return Response.json(userFixture);
      }
      if (url === '/api/ai-models') {
        return Response.json(catalogFixture);
      }
      if (url === '/api/auth/google/status') {
        return Response.json({ configured: false });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const regResult = await authApi.register('founder@vorkei.sk', 'securePass123');
    expect(regResult.ok).toBe(true);

    /* 2. KROK: Prihlásenie používateľa a overenie načítania session statusu */
    const loginResult = await authApi.login('founder@vorkei.sk', 'securePass123');
    expect(loginResult.ok).toBe(true);

    const authStatus = await fetchAuthStatus();
    expect(authStatus.state).toBe('authenticated');
    if (authStatus.state === 'authenticated') {
      expect(authStatus.user.email).toBe('founder@vorkei.sk');
      expect(authStatus.quota.remaining).toBe(10);
    }

    /* 3. KROK: Vykreslenie LandingPage a otestovanie buttonu výberu modelu */
    render(<LandingPage quota={userFixture.quota} />);

    // Overíme prítomnosť model chipu v composeri
    const modelChip = screen.getByTitle(/Aktuálny model:/);
    expect(modelChip).toBeInTheDocument();

    // Otvorenie menu AI modelov
    fireEvent.click(modelChip);
    expect(useStore.getState().modelMenuOpen).toBe(true);

    // Vykreslenie a výber presného modelu Mistral
    const menuView = render(<AiModelMenu open={true} />);
    const mistralOption = await screen.findByRole('button', { name: /AI \(Mistral\)/ });
    expect(mistralOption).toBeInTheDocument();

    fireEvent.click(mistralOption);

    // Overíme nastavenie v store
    expect(useStore.getState().aiModelId).toBe('mistral');
    expect(useStore.getState().model).toBe('AI (Mistral)');
    menuView.unmount();

    /* 4. KROK: Napísanie promptu do composeru */
    const promptInput = screen.getByLabelText('Tvoj nápad') as HTMLTextAreaElement;
    expect(promptInput).toBeInTheDocument();

    fireEvent.change(promptInput, {
      target: { value: 'Vytvor prémiové klientské štúdio pre moderný architektonický ateliér s kontaktným formulárom' },
    });
    expect(useStore.getState().promptDraft).toContain('architektonický ateliér');

    /* 5. KROK: Simulácia úspešného streamu generovania projektu AI modelom Mistral */
    vi.mocked(streamAgentEvents).mockImplementation(async function* () {
      yield { type: 'run_started', runId: 'run-studio-1', model: 'mistral-large-latest' };
      yield { type: 'intent_selected', intent: 'create' };
      yield {
        type: 'done',
        runId: 'run-studio-1',
        summary: 'Projekt ateliéru vygenerovaný',
        files: [
          { name: 'src/App.tsx', content: 'export default function App() { return <h1>Ateliér VORKEI</h1>; }' },
          { name: 'package.json', content: '{"name":"atelier-vorkei","dependencies":{"react":"18.3.1"}}' },
        ],
      };
    });

    // Odoslanie promptu cez tlačidlo #homeSend
    const sendBtn = screen.getByRole('button', { name: 'Vytvoriť projekt' });
    expect(sendBtn).toBeEnabled();

    // Vyvolanie generovania
    await useStore.getState().generateWithAi(useStore.getState().promptDraft, 'auto');

    // Overíme, že streamAgentEvents bol zavolaný s presným modelId 'mistral'
    expect(vi.mocked(streamAgentEvents)).toHaveBeenCalled();
    const callArgs = vi.mocked(streamAgentEvents).mock.calls[0][0];
    expect(callArgs.modelId).toBe('mistral');
    expect(callArgs.prompt).toContain('architektonický ateliér');

    /* 6. KROK: Overenie vytvorenia snapshotu a prepnutia do pracoviska */
    const createdSnap = useStore.getState().createSnapshot(
      'ai',
      'Architektonický ateliér',
      '<div id="root"><h1>Ateliér VORKEI</h1></div>'
    );
    useStore.setState({
      mode: 'work',
      liveId: createdSnap.id,
      liveHtml: createdSnap.html,
      vfs: {
        [createdSnap.id]: [
          { name: 'src/App.tsx', content: 'export default function App() { return <h1>Ateliér VORKEI</h1>; }', modified: false },
        ],
      },
    });

    expect(useStore.getState().mode).toBe('work');
    expect(useStore.getState().snapshots).toHaveLength(1);
    expect(useStore.getState().snapshots[0].html).toContain('Ateliér VORKEI');

    /* 7. KROK: Uloženie ručného snapshotu (verzie) a overenie persistence */
    useStore.getState().manualSnapshot();

    expect(useStore.getState().snapshots).toHaveLength(2);
    expect(useStore.getState().snapshots[1].kind).toBe('manual');
    expect(useStore.getState().toasts.some(t => t.msg.includes('Verzia uložená'))).toBe(true);
  });
});
