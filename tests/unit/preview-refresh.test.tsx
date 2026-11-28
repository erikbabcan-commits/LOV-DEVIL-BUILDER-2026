import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Workspace } from '../../src/features/workspace/Workspace';
import { useStore } from '../../src/stores/useAppStore';

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
afterEach(() => {
  cleanup(); useStore.getState().newProject();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
});

it('refreshes the compiled application without erasing its document or granting same-origin access', () => {
  useStore.getState().newProject();
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: vi.fn(), configurable: true });
  const snap = useStore.getState().createSnapshot('manual', 'preview', '<p>fallback</p>');
  const html = `<html><head><meta http-equiv="Content-Security-Policy" content="form-action 'none'"></head><body>COMPILED_APP</body></html>`;
  useStore.setState({ liveId: snap.id, sandboxHtml: html });
  render(<Workspace />);
  const original = screen.getByTitle('Live preview');
  const documentBeforeRefresh = original.getAttribute('srcdoc')!;
  const preview = new DOMParser().parseFromString(documentBeforeRefresh, 'text/html');
  expect(preview.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toBe("form-action 'none'");
  for (const id of ['__vorkei_runtime_boundary', '__vorkei_inspector_bridge']) {
    const script = preview.getElementById(id);
    expect(script?.tagName).toBe('SCRIPT');
    script!.remove();
  }
  expect(preview.body.innerHTML).toBe('COMPILED_APP');
  expect(original.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
  fireEvent.click(screen.getByTitle('Obnoviť preview'));
  const refreshed = screen.getByTitle('Live preview');
  expect(refreshed).not.toBe(original);
  expect(refreshed.getAttribute('srcdoc')).toBe(documentBeforeRefresh);
  expect(refreshed.getAttribute('sandbox')).not.toContain('allow-same-origin');
});
