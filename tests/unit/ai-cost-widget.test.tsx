import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AiCostWidget, AiCostWidgetLive } from '../../src/features/projects/AiCostWidget';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const priced = (usd: string, eur: string | null) => ({ status: 'priced' as const, usdMicros: usd, eurMicros: eur });
const unpriced = { status: 'unpriced' as const, usdMicros: null, eurMicros: null };

describe('AiCostWidget', () => {
  it('shows last run and session totals in USD and EUR with accessible labels', () => {
    render(<AiCostWidget runs={[priced('1200000', '1104000'), priced('3600', '3312')]} />);
    expect(screen.getByRole('region', { name: 'Odhad ceny AI behov' })).toBeInTheDocument();
    expect(screen.getByLabelText('Cena posledného behu: 0,0036 USD / 0,0033 €')).toBeInTheDocument();
    expect(screen.getByLabelText('Súčet za session: 1,20 USD / 1,11 €')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('shows "neznáma cena" instead of zero when pricing is missing and flags an incomplete sum', () => {
    render(<AiCostWidget runs={[priced('3600', null), unpriced]} />);
    expect(screen.getByLabelText('Cena posledného behu: neznáma cena')).toBeInTheDocument();
    expect(screen.getByLabelText('Súčet za session: 0,0036 USD / EUR neznáme')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Pre 1 z 2 behov chýba cenník alebo spotreba. Súčet je preto neúplný.');
  });
  it('handles the empty and all-unknown states', () => {
    const { rerender } = render(<AiCostWidget runs={[]} />);
    expect(screen.getByLabelText('Cena posledného behu: zatiaľ žiadny beh')).toBeInTheDocument();
    rerender(<AiCostWidget runs={[unpriced]} />);
    expect(screen.getByLabelText('Súčet za session: neznáma cena')).toBeInTheDocument();
  });
  it('live variant asks the server for estimates and degrades to unknown on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ runs: [{ status: 'priced', usdMicros: '3600', eurMicros: '3312' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<AiCostWidgetLive usages={[{ model: 'mistral-large', inputTokens: 1200, outputTokens: 200 }]} />);
    await waitFor(() => expect(screen.getByLabelText('Cena posledného behu: 0,0036 USD / 0,0033 €')).toBeInTheDocument());
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/ai-cost/estimate'); expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ runs: [{ model: 'mistral-large', inputTokens: 1200, outputTokens: 200 }] });
    unmount();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    render(<AiCostWidgetLive usages={[{ model: 'x', inputTokens: 1, outputTokens: 1 }]} />);
    await waitFor(() => expect(screen.getByLabelText('Cena posledného behu: neznáma cena')).toBeInTheDocument());
  });
});
