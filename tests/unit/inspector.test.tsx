import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { useStore } from '../../src/stores/useAppStore';
import { Workspace } from '../../src/features/workspace/Workspace';
import {
  injectInspectorBridge,
  getInspectorBridgeScript,
  INSPECTOR_MESSAGE_TYPE,
  INSPECTOR_SET_MODE_TYPE,
  INSPECTOR_CLEAR_TYPE,
  type InspectedElement,
} from '../../src/features/workspace/inspectorBridge';

beforeEach(() => {
  useStore.getState().newProject();
  useStore.setState({
    mode: 'work',
    editMode: false,
    inspectedElement: null,
    promptDraft: '',
    liveHtml: '<div id="app"><button class="cta-btn">Kúpiť prémium</button></div>',
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Visual Click-to-Edit Inspector (Workspace Preview Iframe -> Chat Composer)', () => {
  describe('1. Injekcia inšpektora do HTML dokumentu (injectInspectorBridge)', () => {
    it('injektuje inšpekčný mostík pred zatvárací tag </body>', () => {
      const original = '<!doctype html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';
      const result = injectInspectorBridge(original, false);

      expect(result).toContain('id="__vorkei_inspector_bridge"');
      expect(result).toContain('__vorkei_inspector_overlay');
      expect(result).toContain(INSPECTOR_MESSAGE_TYPE);
      expect(result).toContain(INSPECTOR_SET_MODE_TYPE);
      expect(result).toContain('var active = false;');
      expect(result.indexOf('id="__vorkei_inspector_bridge"')).toBeLessThan(result.indexOf('</body>'));
    });

    it('rešpektuje počiatočný stav editMode: true', () => {
      const original = '<body><div>Obsah</div></body>';
      const result = injectInspectorBridge(original, true);

      expect(result).toContain('var active = true;');
      expect(result).toContain('cursor = \'crosshair\'');
    });

    it('nevykoná dvojitú injekciu ak už skript existuje', () => {
      const original = '<body><script id="__vorkei_inspector_bridge"></script></body>';
      const result = injectInspectorBridge(original, true);

      const occurrences = (result.match(/id="__vorkei_inspector_bridge"/g) || []).length;
      expect(occurrences).toBe(1);
    });

    it('korektne doplní skript aj pre HTML bez tagu </body>', () => {
      const fragment = '<div class="banner">Jednoduchý fragment</div>';
      const result = injectInspectorBridge(fragment, false);

      expect(result).toContain(fragment);
      expect(result).toContain('id="__vorkei_inspector_bridge"');
    });
  });

  describe('2. Store integrácia — riadenie stavu výberu a prepínanie editMode', () => {
    it('prepína stav editMode v store a maže vybraný prvok pri vypnutí', () => {
      const dummyElement: InspectedElement = {
        tag: 'button',
        text: 'Klikni sem',
        selector: '#cta',
        outerHTML: '<button id="cta">Klikni sem</button>',
      };

      // Zapneme editMode a nastavíme prvok
      useStore.getState().toggleEditMode();
      expect(useStore.getState().editMode).toBe(true);

      useStore.getState().setInspectedElement(dummyElement);
      expect(useStore.getState().inspectedElement).toEqual(dummyElement);

      // Vypneme editMode — inspectedElement sa musí vyčistiť
      useStore.getState().toggleEditMode();
      expect(useStore.getState().editMode).toBe(false);
      expect(useStore.getState().inspectedElement).toBeNull();
    });

    it('clearInspectedElement manuálne vymaže vybraný prvok', () => {
      useStore.getState().setInspectedElement({
        tag: 'h1',
        text: 'Titulok',
        selector: 'h1.title',
        outerHTML: '<h1 class="title">Titulok</h1>',
      });
      expect(useStore.getState().inspectedElement).not.toBeNull();

      useStore.getState().clearInspectedElement();
      expect(useStore.getState().inspectedElement).toBeNull();
    });

    it('newProject resetuje editMode a inspectedElement', () => {
      useStore.getState().toggleEditMode();
      useStore.getState().setInspectedElement({
        tag: 'span',
        text: 'Badge',
        selector: '.badge',
        outerHTML: '<span class="badge">Badge</span>',
      });

      useStore.getState().newProject();
      expect(useStore.getState().editMode).toBe(false);
      expect(useStore.getState().inspectedElement).toBeNull();
    });
  });

  describe('3. React Workspace integrácia a prepojenie s Chat Composerom', () => {
    it('odchytí VORKEI_INSPECT_ELEMENT z iframe, predvyplní prompt draft a zobrazí badge vybraného prvku', async () => {
      render(<Workspace />);

      // Simulujeme odoslanie postMessage z preview iframe
      const inspectedPayload: InspectedElement = {
        tag: 'button',
        text: 'Kúpiť prémium',
        selector: '#app > button.cta-btn',
        outerHTML: '<button class="cta-btn">Kúpiť prémium</button>',
      };

      await act(async () => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: INSPECTOR_MESSAGE_TYPE,
              ...inspectedPayload,
            },
          })
        );
      });

      // 1. Overíme, že v store je zaznamenaný vybraný element
      expect(useStore.getState().inspectedElement).toEqual(inspectedPayload);

      // 2. Overíme, že v prompt drafte je pripravený kontextový prefix
      const currentDraft = useStore.getState().promptDraft;
      expect(currentDraft).toContain('Uprav tento prvok <button>');
      expect(currentDraft).toContain('Kúpiť prémium');

      // 3. Overíme, že v UI sa vykreslil #inspectorTargetBadge s tagom a selektorom
      const badge = await screen.findByRole('status', { name: /Vybraný prvok na úpravu/ });
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent('<button>');
      expect(badge).toHaveTextContent('Kúpiť prémium');
      expect(badge).toHaveTextContent('#app > button.cta-btn');

      // 4. Overíme kliknutie na krížik (clear výberu)
      const clearBtn = screen.getByRole('button', { name: 'Zrušiť výber prvku' });
      expect(clearBtn).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(clearBtn);
      });

      // Po zrušení výberu badge zmizne
      expect(useStore.getState().inspectedElement).toBeNull();
      expect(screen.queryByRole('status', { name: /Vybraný prvok na úpravu/ })).not.toBeInTheDocument();
    });

    it('odoslanie formulára (submit) vyčistí výber inšpektora po zadaní inštrukcie', async () => {
      render(<Workspace />);

      useStore.getState().setInspectedElement({
        tag: 'div',
        text: 'Sekcia s recenziami',
        selector: 'section.reviews',
        outerHTML: '<section class="reviews">Sekcia s recenziami</section>',
      });

      const promptInput = screen.getByLabelText('Popíš zmenu') as HTMLTextAreaElement;
      expect(promptInput).toBeInTheDocument();

      await act(async () => {
        fireEvent.change(promptInput, {
          target: { value: 'Zmeň pozadie sekcie na tmavé a pridaj 5 hviezdičiek' },
        });
      });

      const sendBtn = screen.getByRole('button', { name: /Odoslať/ });
      expect(sendBtn).toBeEnabled();

      const genSpy = vi.spyOn(useStore.getState(), 'generate').mockImplementation(() => {});

      await act(async () => {
        fireEvent.click(sendBtn);
      });

      // Po submite sa inspectedElement vyčistí
      expect(useStore.getState().inspectedElement).toBeNull();
      expect(useStore.getState().promptDraft).toBe('');
      expect(genSpy).toHaveBeenCalledWith('Zmeň pozadie sekcie na tmavé a pridaj 5 hviezdičiek');
    });
  });
});
