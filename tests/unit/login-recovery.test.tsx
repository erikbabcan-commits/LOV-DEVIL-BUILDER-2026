import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LoginScreen } from '../../src/components/LoginScreen';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('login recovery', () => {
  it('restores the submit button after a network failure and permits retry', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(Response.json({ user: {} }));
    vi.stubGlobal('fetch', fetch); const authenticated = vi.fn();
    render(<LoginScreen onAuthenticated={authenticated} />);
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'test@example.com' } });
    fireEvent.change(screen.getByLabelText(/Heslo/), { target: { value: 'local-test-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prihlásiť sa' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Server teraz neodpovedá'));
    expect(screen.getByRole('button', { name: 'Prihlásiť sa' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Prihlásiť sa' }));
    await waitFor(() => expect(authenticated).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
