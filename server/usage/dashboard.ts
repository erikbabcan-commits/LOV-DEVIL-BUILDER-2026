import { readFileSync } from 'node:fs';
import type { aiCostReport } from './costReport';
const template=readFileSync(new URL('../../deploy/ops/ai-cost-dashboard.template.html',import.meta.url),'utf8');
export function renderAiCostDashboard(report:Awaited<ReturnType<typeof aiCostReport>>, options: {demo?: boolean} = {}):string {
  // JSON is embedded in a raw-text element. Escape '<' so even a malicious
  // internal ID cannot end the script; all UI data uses textContent.
  const data=JSON.stringify({...report,demo:options.demo === true}).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
  return template.replace('__AI_COST_REPORT_JSON__',()=>data);
}
