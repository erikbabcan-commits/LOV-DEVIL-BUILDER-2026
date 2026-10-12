import type { ChatMessage, AIProvider } from '../providers/types';
import type { GenerateRequest } from './schemas';
import { PlanSchema, GeneratedFileSchema } from './schemas';
import type { Plan, GeneratedFile } from './schemas';

/* Lifecycle: PROMPT → PLAN → GENERATE → VALIDATE → STAGE → REVIEW/APPLY.
   Eventy sú reálne — vydáva ich agent podľa skutočného priebehu, nie timery. */

const SYSTEM_PLAN = `Si Forge Agent — plánuješ webové aplikácie.
Na základe používateľského promptu a existujúceho kontextu projektu vytvor PLÁN.
Odpovedaj VÝHRADNE JSON objektom (žiadny markdown, žiadne markdown bloky):
{"summary": string, "steps": [{"id": string, "title": string, "detail": string}], "filesPlanned": string[]}
Pravidlá:
- 3-6 krokov, každý id krátky (napr. "scaffold", "components").
- filesPlanned: relatívne cesty (package.json, index.html, src/main.tsx, src/App.tsx, src/index.css + komponenty podľa potreby).
- Pri mode "iterate"/"fix" plánuj úpravy existujúcich súborov.`;

const SYSTEM_GENERATE = `Si Forge Agent — generuješ kód reálneho React + Vite + TypeScript projektu.
Odpovedaj VÝHRADNE JSON objektom (žiadny markdown, žiadne markdown bloky):
{"files": [{"path": string, "content": string, "action": "create"|"modify"}]}
Pravidlá:
- Vždy kompletný obsah súborov (nie diffy).
- Minimálne: package.json, index.html, src/main.tsx, src/App.tsx, src/index.css.
- package.json: name, private, dependencies (react, react-dom), devDependencies (@types/react, @types/react-dom, @vitejs/plugin-react, typescript, vite), scripts (dev/build/preview).
- React 18, Vite, TypeScript strict, žiadne TODO komentáre, kód musí byť kompletný a spustiteľný.
- Žiadne secrets/API kľúče v kóde. Obsah generuj podľa plánu a používateľského promptu.`;

function contextBlock(req: GenerateRequest): string {
  const parts: string[] = [];
  if (req.context.projectTitle) parts.push(`Projekt: ${req.context.projectTitle}`);
  if (req.context.files.length) {
    parts.push('Existujúce súbory:');
    for (const f of req.context.files.slice(0, 40)) {
      parts.push(`--- ${f.path} ---\n${f.content.slice(0, 3000)}`);
    }
  }
  if (req.context.history.length) {
    parts.push('História promptov: ' + req.context.history.map(h => `v${h.v}: ${h.prompt}`).join('; '));
  }
  return parts.join('\n');
}

/** Extrahuje JSON z odpovede modelu (toleruje obalenie markdownom). */
export function extractJson<T>(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('model output neobsahuje JSON');
  return JSON.parse(t.slice(start, end + 1));
}

export async function requestPlan(provider: AIProvider, req: GenerateRequest, signal?: AbortSignal): Promise<Plan> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PLAN },
    { role: 'user', content: `Prompt: ${req.prompt}\nMód: ${req.mode}\n${contextBlock(req)}` },
  ];
  const { text } = await provider.complete(messages, { maxTokens: 1024, temperature: 0.1, signal });
  const parsed = PlanSchema.safeParse(extractJson(text));
  if (!parsed.success) {
    throw new Error('plan: nevalidná odpoveď modelu: ' + parsed.error.issues.slice(0, 3).map(i => i.path.join('.') + ' ' + i.message).join('; '));
  }
  return parsed.data;
}

export async function requestFiles(provider: AIProvider, req: GenerateRequest, plan: Plan, signal?: AbortSignal): Promise<GeneratedFile[]> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_GENERATE },
    { role: 'user', content: `Prompt: ${req.prompt}\nMód: ${req.mode}\nPlán:\n${plan.summary}\nKroky: ${plan.steps.map(s => s.title).join('; ')}\nSúbory na vytvorenie: ${plan.filesPlanned.join(', ')}\n${contextBlock(req)}` },
  ];
  const { text } = await provider.complete(messages, { maxTokens: 16_000, temperature: 0.2, signal });
  const raw = extractJson(text) as { files?: unknown };
  const parsed = GeneratedFileSchema.array().safeParse(Array.isArray(raw) ? raw : raw.files);
  if (!parsed.success || parsed.data.length === 0) {
    throw new Error('files: model nevrátil žiadne validné súbory');
  }
  return parsed.data;
}
