import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AiUsageCard } from '../../src/features/projects/AiUsageCard';
const report={periodStart:'2026-11-01',periodEnd:'2026-12-01',calls:4,reportedCalls:3,unknownCalls:1,pendingCalls:1,promptTokens:1200,completionTokens:200};
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('honest token usage display',()=>{
  it('shows reported input/output tokens and incomplete coverage',async()=>{
    const fetch=vi.fn().mockResolvedValue(Response.json(report));vi.stubGlobal('fetch',fetch);render(<AiUsageCard/>);
    expect(await screen.findByText(/1 200 vstupných/)).toBeInTheDocument();expect(screen.getByRole('status')).toHaveTextContent('Súčet je preto neúplný');
    expect(fetch).toHaveBeenCalledWith('/api/ai-usage',expect.objectContaining({credentials:'same-origin',cache:'no-store'}));
  });
  it('shows unavailable for invalid data and permits an explicit retry',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(Response.json({...report,reportedCalls:4})).mockResolvedValueOnce(Response.json({...report,calls:0,reportedCalls:0,unknownCalls:0,pendingCalls:0,promptTokens:0,completionTokens:0}));
    vi.stubGlobal('fetch',fetch);render(<AiUsageCard/>);expect(await screen.findByRole('status')).toHaveTextContent('nepodarilo');
    fireEvent.click(screen.getByRole('button',{name:'Obnoviť spotrebu'}));expect(await screen.findByText('0 vstupných · 0 výstupných')).toBeInTheDocument();
  });
  it('ignores a late report from an unmounted account card',async()=>{
    let finish!:(value:Response)=>void;
    const fetch=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce(Response.json({...report,promptTokens:9,completionTokens:3}));
    vi.stubGlobal('fetch',fetch);const view=render(<AiUsageCard key="alice"/>);view.rerender(<AiUsageCard key="bob"/>);
    await screen.findByText('9 vstupných · 3 výstupných');finish(Response.json(report));
    await Promise.resolve();expect(screen.queryByText(/1 200 vstupných/)).not.toBeInTheDocument();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
