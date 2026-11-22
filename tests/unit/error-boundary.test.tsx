import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { useStore } from '../../src/stores/useAppStore';
import { Workspace } from '../../src/features/workspace/Workspace';
import {
  injectRuntimeBoundary,
  getRuntimeBoundaryScript,
  RUNTIME_CRASH_MESSAGE_TYPE,
  RUNTIME_ERROR_DETECTED_TYPE,
  type RuntimeCrashPayload
} from '../../src/features/workspace/runtimeBoundary';

beforeEach(() => {
  useStore.getState().newProject();
  useStore.setState({
    mode: 'work',
    model: 'Mistral (Large)',
    editMode: false,
    inspectedElement: null,
    runtimeCrash: null,
    promptDraft: '',
    liveHtml: '<!doctype html><html><head><title>Test App</title></head><body><div id="root">Obsah</div></body></html>',
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('🛡️ AI Self-Healing Error Boundary (Preview Iframe -> Crash Recovery & Repair)', () => {
  describe('1. Injekcia Runtime Boundary do HTML dokumentu (injectRuntimeBoundary)', () => {
    it('injektuje boundary skript do tagu <head>', () => {
      const html = '<!doctype html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';
      const injected = injectRuntimeBoundary(html);

      expect(injected).toContain('id="__vorkei_runtime_boundary"');
      expect(injected).toContain('window.onerror');
      expect(injected).toContain('unhandledrejection');
      expect(injected).toContain('__vorkei_crash_overlay');
      expect(injected).toContain(RUNTIME_CRASH_MESSAGE_TYPE);
      expect(injected).toContain(RUNTIME_ERROR_DETECTED_TYPE);

      // Overenie umiestnenia v <head>
      expect(injected.indexOf('id="__vorkei_runtime_boundary"')).toBeLessThan(injected.indexOf('<body>'));
    });

    it('injektuje skript aj do HTML bez <head>', () => {
      const html = '<body><div id="app">Simple</div></body>';
      const injected = injectRuntimeBoundary(html);

      expect(injected).toContain('id="__vorkei_runtime_boundary"');
      expect(injected).toContain('<body><script id="__vorkei_runtime_boundary"');
    });

    it('nevykoná dvojitú injekciu ak už boundary skript existuje', () => {
      const html = '<html><head><script id="__vorkei_runtime_boundary"></script></head><body>OK</body></html>';
      const injected = injectRuntimeBoundary(html);

      const count = (injected.match(/id="__vorkei_runtime_boundary"/g) || []).length;
      expect(count).toBe(1);
    });

    it('obsahuje tlačidlá pre AI opravu, reload a dismiss', () => {
      const script = getRuntimeBoundaryScript();
      expect(script).toContain('__vorkei_repair_btn');
      expect(script).toContain('__vorkei_reload_btn');
      expect(script).toContain('__vorkei_dismiss_btn');
      expect(script).toContain('Opraviť cez AI (Mistral)');
      expect(script).toContain('window.location.reload()');
    });
  });

  describe('2. Store integrácia — stav runtimeCrash a triggerAiRuntimeRepair', () => {
    it('nastavuje a maže stav runtimeCrash v store', () => {
      const payload: RuntimeCrashPayload = {
        message: 'TypeError: Cannot read properties of undefined (reading "map")',
        component: 'ProductList',
        stack: 'at ProductList (ProductList.tsx:14:10)',
        timestamp: Date.now()
      };

      act(() => {
        useStore.getState().setRuntimeCrash(payload);
      });

      expect(useStore.getState().runtimeCrash).toEqual(payload);

      act(() => {
        useStore.getState().clearRuntimeCrash();
      });

      expect(useStore.getState().runtimeCrash).toBeNull();
    });

    it('newProject resetuje runtimeCrash na null', () => {
      act(() => {
        useStore.getState().setRuntimeCrash({
          message: 'SyntaxError: Unexpected token',
          timestamp: Date.now()
        });
      });
      expect(useStore.getState().runtimeCrash).not.toBeNull();

      act(() => {
        useStore.getState().newProject();
      });

      expect(useStore.getState().runtimeCrash).toBeNull();
    });

    it('triggerAiRuntimeRepair sformuluje opravný prompt a zavolá generateWithAi v režime fix', async () => {
      const generateWithAiSpy = vi.spyOn(useStore.getState(), 'generateWithAi').mockResolvedValue();

      const payload: RuntimeCrashPayload = {
        message: 'ReferenceError: userData is not defined',
        component: 'UserProfile',
        stack: 'at UserProfile (UserProfile.tsx:22:5)',
        timestamp: Date.now()
      };

      act(() => {
        useStore.getState().setRuntimeCrash(payload);
      });

      await act(async () => {
        await useStore.getState().triggerAiRuntimeRepair();
      });

      expect(generateWithAiSpy).toHaveBeenCalledTimes(1);
      const [promptPassed, modePassed] = generateWithAiSpy.mock.calls[0];
      expect(modePassed).toBe('fix');
      expect(promptPassed).toContain('Oprav nasledujúcu runtime chybu v komponente <UserProfile>');
      expect(promptPassed).toContain('ReferenceError: userData is not defined');
      expect(promptPassed).toContain('UserProfile.tsx:22:5');

      // Banner sa resetuje po spustení opravy
      expect(useStore.getState().runtimeCrash).toBeNull();
    });
  });

  describe('3. React Workspace integrácia a Crash Banner v Composeri', () => {
    it('zobrazí #runtimeCrashBanner po prijatí správy VORKEI_RUNTIME_ERROR_DETECTED z iframe', async () => {
      render(<Workspace />);

      // Spočiatku banner nie je prítomný
      expect(document.getElementById('runtimeCrashBanner')).toBeNull();

      // Simulácia runtime chyby z preview iframe
      act(() => {
        window.dispatchEvent(new MessageEvent('message', {
          data: {
            type: RUNTIME_ERROR_DETECTED_TYPE,
            message: 'Uncaught TypeError: items.filter is not a function',
            component: 'FilterBar',
            stack: 'at FilterBar (FilterBar.tsx:8:12)'
          }
        }));
      });

      await waitFor(() => {
        expect(document.getElementById('runtimeCrashBanner')).not.toBeNull();
      });

      const banner = document.getElementById('runtimeCrashBanner')!;
      expect(banner.textContent).toContain('items.filter is not a function');
      expect(banner.textContent).toContain('<FilterBar>');
      expect(document.getElementById('runtimeRepairBtn')).not.toBeNull();
    });

    it('kliknutie na tlačidlo Opraviť cez AI v banneri spustí AI opravu', async () => {
      const repairSpy = vi.spyOn(useStore.getState(), 'triggerAiRuntimeRepair').mockResolvedValue();

      render(<Workspace />);

      act(() => {
        useStore.getState().setRuntimeCrash({
          message: 'NetworkError when attempting to fetch resource.',
          component: 'ApiCard',
          timestamp: Date.now()
        });
      });

      await waitFor(() => {
        expect(document.getElementById('runtimeRepairBtn')).not.toBeNull();
      });

      const repairBtn = document.getElementById('runtimeRepairBtn')!;
      await act(async () => {
        fireEvent.click(repairBtn);
      });

      expect(repairSpy).toHaveBeenCalledTimes(1);
    });

    it('správa VORKEI_RUNTIME_CRASH_REPAIR z iframe automaticky spustí opravu', async () => {
      const repairSpy = vi.spyOn(useStore.getState(), 'triggerAiRuntimeRepair').mockResolvedValue();

      render(<Workspace />);

      act(() => {
        window.dispatchEvent(new MessageEvent('message', {
          data: {
            type: RUNTIME_CRASH_MESSAGE_TYPE,
            message: 'Uncaught TypeError: Cannot read property "name" of null',
            component: 'HeaderUser',
            stack: 'at HeaderUser (Header.tsx:15:20)'
          }
        }));
      });

      await waitFor(() => {
        expect(repairSpy).toHaveBeenCalledTimes(1);
      });
      expect(repairSpy).toHaveBeenCalledWith(expect.objectContaining({
        message: 'Uncaught TypeError: Cannot read property "name" of null',
        component: 'HeaderUser'
      }));
    });
  });
});
