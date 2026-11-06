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
  expect(original.getAttribute('srcdoc')).toBe(html);
  expect(original.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
  fireEvent.click(screen.getByTitle('Obnoviť preview'));
  const refreshed = screen.getByTitle('Live preview');
  expect(refreshed).not.toBe(original);
  expect(refreshed.getAttribute('srcdoc')).toBe(html);
  expect(refreshed.getAttribute('sandbox')).not.toContain('allow-same-origin');
});
