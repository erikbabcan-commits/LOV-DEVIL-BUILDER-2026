// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { aiCostReport, costReportWindow } from '../../../server/usage/costReport';
const row={user_id:'alice',plan:'free',calls:'3',reported_calls:'2',priced_calls:'1',pending_calls:'1',legacy_calls:'1',input_tokens:'12345678901234567890',output_tokens:'1',cost_micros:'12345678901234567890'};
const fake=(rows:unknown[])=>({query:vi.fn().mockResolvedValueOnce({rows:[],rowCount:0}).mockResolvedValueOnce({rows,rowCount:rows.length})});
describe('operator cost read model',()=>{
  it('preserves exact large decimal sums and distinguishes a partial known subtotal from complete recorded costs',async()=>{
    const db=fake([row]);const report=await aiCostReport(db,{month:'2026-11',userId:'alice',plan:'free'});
    expect(report.totals).toMatchObject({estimatedKnownCostUsd:'12345678901234.567890',estimatedRecordedCostUsd:null,unknownCostCalls:'2',promptTokens:row.input_tokens});
    expect(db.query.mock.calls.every(([,params])=>params[0].toISOString()==='2026-11-01T00:00:00.000Z' && params[1].toISOString()==='2026-12-01T00:00:00.000Z' && params[2]==='alice' && params[3]==='free')).toBe(true);
    expect(report.coverage).toBe('recorded_calls_only');
  });
  it.each(['2026-00','2026-13','2026-1','invalid','0000-01','9999-12'])('rejects invalid report month %s before any query',async month=>{
    const db=fake([]);await expect(aiCostReport(db,{month})).rejects.toThrow();expect(db.query).not.toHaveBeenCalled();
  });
  it('validates filters and computes December rollover in UTC',()=>{
    expect(costReportWindow({month:'2026-12'}).end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(()=>costReportWindow({month:'2026-11',userId:'x\nprivate'})).toThrow();
    expect(()=>costReportWindow({month:'2026-11',plan:'admin' as 'pro'})).toThrow();
  });
  it.each([{...row,cost_micros:'1.5'},{...row,priced_calls:'4'},{...row,reported_calls:'-1'}])('rejects corrupt aggregates without producing a misleading report',async bad=>{
    await expect(aiCostReport(fake([bad]),{month:'2026-11'})).rejects.toThrow('ai_cost_report_unavailable');
  });
  it('refuses a truncated account grouping instead of silently publishing partial totals',async()=>{
    await expect(aiCostReport(fake(Array.from({length:501},()=>row)),{month:'2026-11'})).rejects.toThrow();
  });
});
