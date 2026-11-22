import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { LoginScreen } from '../../src/components/LoginScreen';
import { LandingPage } from '../../src/features/landing/LandingPage';
import { AiModelMenu } from '../../src/components/AiModelMenu';
import { useStore } from '../../src/stores/useAppStore';
import { authApi } from '../../src/services/auth';
import { streamAgentEvents, NetworkError } from '../../src/services/ai/client';

vi.mock('../../src/services/ai/client', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/services/ai/client')>(),
  streamAgentEvents: vi.fn(),
}));

const catalogFixture = {
  defaultId: 'mistral',
  models: [
    { id: 'mistral', label: 'AI (Mistral)', provider: 'mistral', model: 'mistral-large-latest', fallbackIds: ['openai'] },
    { id: 'openai', label: 'AI (OpenAI)', provider: 'openai', model: 'gpt-4o', fallbackIds: [] },
  ],
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

describe('Ostrý Regresný Test — hraničné stavy, zlyhania a zotavenie', () => {
  /* 1. SEKCIA: Autentifikácia — chyby, validácie a sieťový výpadok */
  describe('1. Autentifikačné validácie a zotavenie', () => {
    it('zobrazí chybu pri obsadenom emaile pri registrácii a umožní okamžitú zmenu', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'email_taken' }), { status: 409, headers: { 'Content-Type': 'application/json' } })
      );
      vi.stubGlobal('fetch', mockFetch);

      const onAuth = vi.fn();
      render(<LoginScreen onAuthenticated={onAuth} />);

      // Prepnutie do režimu registrácie
      fireEvent.click(screen.getByText('Nemáš účet? Zaregistruj sa'));
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Registrácia');

      fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'existing@vorkei.sk' } });
      fireEvent.change(screen.getByLabelText(/Heslo/), { target: { value: 'password123' } });

      fireEvent.click(screen.getByRole('button', { name: 'Vytvoriť účet' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Tento e-mail už je zaregistrovaný.');
      });
      expect(onAuth).not.toHaveBeenCalled();

      // Používateľ zmení e-mail a skúsi znova
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'fresh@vorkei.sk' } });
      fireEvent.click(screen.getByRole('button', { name: 'Vytvoriť účet' }));

      await waitFor(() => {
        expect(onAuth).toHaveBeenCalledTimes(1);
      });
    });

    it('zvládne dočasný sieťový výpadok (503/offline) a umožní opakovaný pokus bez straty údajov', async () => {
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new Error('Failed to fetch'))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      vi.stubGlobal('fetch', mockFetch);

      const onAuth = vi.fn();
      render(<LoginScreen onAuthenticated={onAuth} />);

      fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'test@vorkei.sk' } });
      fireEvent.change(screen.getByLabelText(/Heslo/), { target: { value: 'password123' } });

      fireEvent.click(screen.getByRole('button', { name: 'Prihlásiť sa' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Server teraz neodpovedá');
      });

      // Tlačidlo musí byť opäť aktívne a údaje zachované
      expect(screen.getByRole('button', { name: 'Prihlásiť sa' })).toBeEnabled();
      expect((screen.getByLabelText('E-mail') as HTMLInputElement).value).toBe('test@vorkei.sk');

      // Druhý pokus je úspešný
      fireEvent.click(screen.getByRole('button', { name: 'Prihlásiť sa' }));
      await waitFor(() => {
        expect(onAuth).toHaveBeenCalledTimes(1);
      });
    });
  });

  /* 2. SEKCIA: Model Picker & Katalóg modelov */
  describe('2. Model Picker & Odolnosť katalógu modelov', () => {
    it('udrží bezpečný Instant Draft a nespôsobí pád aplikácie pri zlyhaní serverového katalógu (503)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));

      render(<AiModelMenu open={true} />);

      await screen.findByText('Ponuku AI modelov sa nepodarilo načítať.');
      expect(screen.queryByRole('button', { name: /AI \(Mistral\)/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Instant Draft/ })).toBeEnabled();
      expect(useStore.getState().model).toBe('Instant Draft');
    });

    it('uchová rozpracovaný prompt draft v composeri aj po zmene modelu', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(catalogFixture)));
      render(<LandingPage />);

      const promptInput = screen.getByLabelText('Tvoj nápad') as HTMLTextAreaElement;
      fireEvent.change(promptInput, { target: { value: 'Dôležitý rozpracovaný projekt s detailným popisom funkcií' } });
      expect(useStore.getState().promptDraft).toContain('Dôležitý rozpracovaný');

      // Zmena modelu
      const menuView = render(<AiModelMenu open={true} />);
      const mistralBtn = await screen.findByRole('button', { name: /AI \(Mistral\)/ });
      fireEvent.click(mistralBtn);

      expect(useStore.getState().aiModelId).toBe('mistral');
      expect(useStore.getState().promptDraft).toBe('Dôležitý rozpracovaný projekt s detailným popisom funkcií');
      menuView.unmount();
    });

    it('zablokuje odoslanie pre prázdny alebo whitespace-only prompt', () => {
      render(<LandingPage />);
      const sendBtn = screen.getByRole('button', { name: 'Vytvoriť projekt' });
      expect(sendBtn).toBeDisabled();

      const promptInput = screen.getByLabelText('Tvoj nápad');
      fireEvent.change(promptInput, { target: { value: '   \n\t   ' } });
      expect(sendBtn).toBeDisabled();
    });
  });

  /* 3. SEKCIA: Prerušenie AI generovania & Zachovanie stavu */
  describe('3. AI Generovanie — prerušenie a sieťová odolnosť', () => {
    it('správne spracuje manuálne zastavenie generovania používateľom (cancel) bez poškodenia stavu', async () => {
      vi.mocked(streamAgentEvents).mockImplementation(async function* (_input, signal) {
        yield { type: 'run_started', runId: 'cancel-run', model: 'mistral-large-latest' };
        yield { type: 'intent_selected', intent: 'create' };
        yield { type: 'text_delta', delta: 'Časť generovaného kódu…' };
        signal.throwIfAborted();
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      });

      const work = useStore.getState().generateWithAi('Navrhni e-shop', 'auto');
      await waitFor(() => expect(useStore.getState().generating).toBe(true));

      // Používateľ stlačí Zastaviť (cancel)
      useStore.getState().cancelAiRun();
      await work;

      expect(useStore.getState().generating).toBe(false);
      expect(useStore.getState().messages.at(-1)?.text).toContain('zastavená');
      expect(useStore.getState().pendingReview).toBeNull();
    });

    it('uchová čiastočnú odpoveď pri výpadku siete počas streamu', async () => {
      vi.mocked(streamAgentEvents).mockImplementation(async function* () {
        yield { type: 'run_started', runId: 'net-err', model: 'mistral-large-latest' };
        yield { type: 'text_delta', delta: 'Rozpracovaná sekcia pred výpadkom.' };
        throw new NetworkError(true);
      });

      await useStore.getState().generateWithAi('Vytvor blog', 'auto');

      const lastMsg = useStore.getState().messages.at(-1);
      expect(lastMsg?.text).toContain('Rozpracovaná sekcia pred výpadkom.');
      expect(lastMsg?.text).toContain('neúplná');
      expect(useStore.getState().generating).toBe(false);
    });
  });

  /* 4. SEKCIA: Project Persistence & Obnova */
  describe('4. Perzistencia a obnova integrity projektu', () => {
    it('aktualizuje titulok projektu a zachová ho pri ručnom uložení checkpointu (manualSnapshot)', async () => {
      const snap = useStore.getState().createSnapshot('ai', 'Počiatočný stav', '<div>Pôvodný kód</div>');
      useStore.setState({
        mode: 'work',
        liveId: snap.id,
        liveHtml: snap.html,
        projectTitle: 'Architektúra 2026',
        vfs: {
          [snap.id]: [{ name: 'src/App.tsx', content: 'export default () => <h1>A2026</h1>;', modified: false }],
        },
      });

      // Zmena titulku
      useStore.getState().setTitle('Architektúra 2026 - Finálna Verzia');
      expect(useStore.getState().projectTitle).toBe('Architektúra 2026 - Finálna Verzia');

      // Ručný checkpoint
      useStore.getState().manualSnapshot();

      const snapshots = useStore.getState().snapshots;
      expect(snapshots).toHaveLength(2);
      expect(snapshots[1].kind).toBe('manual');
      expect(useStore.getState().projectTitle).toBe('Architektúra 2026 - Finálna Verzia');
    });

    it('správne deserializuje projekt a VFS súbory pri obnove (restoreWorkspace)', async () => {
      const initialSnap = useStore.getState().createSnapshot('ai', 'Appka', '<div>Obnovená appka</div>');
      const files = [
        { name: 'src/main.tsx', content: 'import React from "react";', modified: false },
        { name: 'package.json', content: '{"name":"restored-app"}', modified: false },
      ];

      useStore.setState({
        liveId: initialSnap.id,
        liveHtml: initialSnap.html,
        snapshots: [{ ...initialSnap, sourceFiles: JSON.stringify(files) }],
        vfs: { [initialSnap.id]: files },
      });

      // Uložíme do persistence
      const persistOk = await useStore.getState().persistNow();
      expect(persistOk).toBe(true);

      // Vyčistíme pamäťový stav simulujúc refresh stránky
      useStore.setState({ snapshots: [], vfs: {}, liveId: null, liveHtml: null });

      // Obnova
      await useStore.getState().restoreFromDb();

      expect(useStore.getState().snapshots.length).toBeGreaterThanOrEqual(1);
      const restoredLiveId = useStore.getState().liveId;
      expect(restoredLiveId).toBeTruthy();
      if (restoredLiveId) {
        const restoredFiles = useStore.getState().vfs[restoredLiveId];
        expect(restoredFiles?.some(f => f.name === 'src/main.tsx')).toBe(true);
      }
    });
  });
});
