import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { useStore } from '../../src/stores/useAppStore';
import { shareRouter } from '../../server/share/routes';
import { TopBar } from '../../src/components/TopBar';
import { ShareModal } from '../../src/components/ShareModal';
import * as shareService from '../../src/services/share/shareService';

beforeEach(() => {
  useStore.getState().newProject();
  useStore.setState({
    mode: 'work',
    projectTitle: 'Klientský CRM Systém',
    projectId: 'test-crm-123',
    liveHtml: '<!doctype html><html><body><h1>Moje CRM</h1></body></html>',
    shareModalOpen: false,
    lastShareUrl: null,
    lastShareId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('🔗 1-Click Instant Shareable Link (Verejný náhľad pre klientov)', () => {
  describe('1. Backend Share Router (server/share/routes.ts)', () => {
    it('POST /api/share/create úspešne vygeneruje verejný shareId a shareUrl', async () => {
      const app = shareRouter(null, () => true);

      const res = await app.request('/api/share/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Host': 'lov.2.29.52.59.sslip.io'
        },
        body: JSON.stringify({
          projectId: 'proj-xyz',
          title: 'Kaviareň Web',
          html: '<div>Menu kaviareň</div>'
        })
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.shareId).toMatch(/^sh_[a-z0-9_-]+$/);
      expect(data.shareUrl).toBe(`https://lov.2.29.52.59.sslip.io/p/${data.shareId}`);
      expect(data.title).toBe('Kaviareň Web');
    });

    it('POST /api/share/create odmietne prázdne HTML s kódom 400', async () => {
      const app = shareRouter(null, () => true);

      const res = await app.request('/api/share/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-1', html: '   ' })
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('html_required');
    });

    it('GET /api/share/:shareId vráti uložené HTML a metadáta', async () => {
      const app = shareRouter(null, () => true);

      // Najprv vytvoríme share
      const createRes = await app.request('/api/share/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-read',
          title: 'Portfólio 2026',
          html: '<h1>Moje práce</h1>'
        })
      });
      const { shareId } = await createRes.json();

      // Získame detail
      const getRes = await app.request(`/api/share/${shareId}`);
      expect(getRes.status).toBe(200);
      const data = await getRes.json();
      expect(data.ok).toBe(true);
      expect(data.shareId).toBe(shareId);
      expect(data.title).toBe('Portfólio 2026');
      expect(data.html).toBe('<h1>Moje práce</h1>');
    });

    it('GET /p/:shareId vráti standalone HTML shell s watermarkom a viewport toggle', async () => {
      const app = shareRouter(null, () => true);

      const createRes = await app.request('/api/share/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'proj-full',
          title: 'E-Shop Nábytok',
          html: '<div id="app">Sedačky a stoly</div>'
        })
      });
      const { shareId } = await createRes.json();

      const pageRes = await app.request(`/p/${shareId}`);
      expect(pageRes.status).toBe(200);
      expect(pageRes.headers.get('Content-Type')).toContain('text/html');

      const html = await pageRes.text();
      expect(html).toContain('E-Shop Nábytok · VORKEI Client Preview');
      expect(html).toContain('client-preview-frame');
      expect(html).toContain('Built with <strong>VORKEI AI</strong>');
      expect(html).toContain('Postav si vlastnú appku →');
      expect(html).toContain('btn-mobile');
      expect(html).toContain('btn-desktop');
    });

    it('GET /p/:shareId vráti 404 pre neexistujúci odkaz', async () => {
      const app = shareRouter(null, () => true);
      const res = await app.request('/p/sh_nonexistent99');
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(text).toContain('404 · Náhľad nenájdený');
    });
  });

  describe('2. Store integrácia — generateInstantShareLink', () => {
    it('vygeneruje odkaz, uloží do store a skopíruje do schránky', async () => {
      const writeTextSpy = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: writeTextSpy }
      });

      vi.spyOn(shareService, 'createInstantShare').mockResolvedValue({
        ok: true,
        shareId: 'sh_clienttest1',
        shareUrl: 'https://lov.2.29.52.59.sslip.io/p/sh_clienttest1',
        title: 'Klientský CRM Systém'
      });

      let returnedUrl: string | null = null;
      await act(async () => {
        returnedUrl = await useStore.getState().generateInstantShareLink();
      });

      expect(returnedUrl).toBe('https://lov.2.29.52.59.sslip.io/p/sh_clienttest1');
      expect(useStore.getState().lastShareUrl).toBe('https://lov.2.29.52.59.sslip.io/p/sh_clienttest1');
      expect(useStore.getState().lastShareId).toBe('sh_clienttest1');
      expect(useStore.getState().shareModalOpen).toBe(true);
      expect(writeTextSpy).toHaveBeenCalledWith('https://lov.2.29.52.59.sslip.io/p/sh_clienttest1');
    });

    it('newProject resetuje share stav', () => {
      act(() => {
        useStore.setState({
          shareModalOpen: true,
          lastShareUrl: 'https://example.com/p/123',
          lastShareId: '123'
        });
      });

      act(() => {
        useStore.getState().newProject();
      });

      expect(useStore.getState().shareModalOpen).toBe(false);
      expect(useStore.getState().lastShareUrl).toBeNull();
      expect(useStore.getState().lastShareId).toBeNull();
    });
  });

  describe('3. React UI — TopBar tlačidlo Zdieľať a ShareModal', () => {
    it('TopBar obsahuje tlačidlo #shareInstantBtn, ktoré vyvolá generovanie odkazu', async () => {
      const generateSpy = vi.spyOn(useStore.getState(), 'generateInstantShareLink').mockResolvedValue('https://test/p/1');

      render(<TopBar />);

      const shareBtn = document.getElementById('shareInstantBtn');
      expect(shareBtn).not.toBeNull();

      await act(async () => {
        fireEvent.click(shareBtn!);
      });

      expect(generateSpy).toHaveBeenCalledTimes(1);
    });

    it('ShareModal zobrazí verejnú URL, QR kód a tlačidlo na kopírovanie', async () => {
      const writeTextSpy = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, {
        clipboard: { writeText: writeTextSpy }
      });

      act(() => {
        useStore.setState({
          shareModalOpen: true,
          lastShareUrl: 'https://lov.2.29.52.59.sslip.io/p/sh_ab12cd34'
        });
      });

      render(<ShareModal />);

      expect(screen.getByText('1-Click Instant Shareable Link')).toBeDefined();
      expect(screen.getByText('Live & Public')).toBeDefined();
      expect(screen.getByText('Nevyžaduje účet ani heslo')).toBeDefined();

      const input = document.getElementById('shareUrlInput') as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(input.value).toBe('https://lov.2.29.52.59.sslip.io/p/sh_ab12cd34');

      const copyBtn = document.getElementById('copyShareUrlBtn')!;
      await act(async () => {
        fireEvent.click(copyBtn);
      });

      expect(writeTextSpy).toHaveBeenCalledWith('https://lov.2.29.52.59.sslip.io/p/sh_ab12cd34');
      expect(copyBtn.textContent).toContain('Skopírované');

      // Tlačidlo zatvorenia
      const closeBtn = document.getElementById('closeShareModalBtn')!;
      act(() => {
        fireEvent.click(closeBtn);
      });
      expect(useStore.getState().shareModalOpen).toBe(false);
    });
  });
});
