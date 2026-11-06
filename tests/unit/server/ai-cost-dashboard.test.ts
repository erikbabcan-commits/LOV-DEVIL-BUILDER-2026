// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { aiCostReport } from '../../../server/usage/costReport';
import { renderAiCostDashboard } from '../../../server/usage/dashboard';
describe('offline cost dashboard artifact',()=>{
  it('embeds data without an executable closing-script or replacement token, and blocks network access',async()=>{
    let query=0;
    const userId='demo$&</script><img src=x onerror=alert(1)>';
    const report=await aiCostReport({query:async()=>({rows:query++===0?[]:[{user_id:userId,plan:'free',calls:'1',reported_calls:'1',priced_calls:'0',pending_calls:'0',legacy_calls:'1',input_tokens:'1',output_tokens:'2',cost_micros:'0'}],rowCount:1})},{month:'2026-11'});
    const html=renderAiCostDashboard(report);
    expect(html).toContain("connect-src 'none'");expect(html).not.toContain('__AI_COST_REPORT_JSON__');
    const embedded=html.match(/id="report-data">([\s\S]*?)<\/script>/)![1];
    expect(embedded).not.toContain('</script>');expect(JSON.parse(embedded).accounts[0].userId).toBe(userId);
    expect(html).toContain('document.createElement');expect(html).not.toMatch(/\.innerHTML\s*=/);
    expect(html).not.toMatch(/https?:\/\//);
  });
});
