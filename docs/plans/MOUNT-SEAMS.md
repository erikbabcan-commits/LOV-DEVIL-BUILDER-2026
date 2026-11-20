# Montážne švy (LOV-DEVIL 10 epikov, krok 0)

Cieľ: agenti 1, 3, 5, 7, 8, 9 nesmú meniť ten istý blok v `server/index.ts`, aby pri `merge --no-ff` nevznikali konflikty.

## server/index.ts
V `createApp()` sú komentárové sloty `// [seam:agent-N]` … `// [/seam:agent-N]`:
- v bloku `if (opts?.auth) { … }` (owner-scoped, prihlásenie povinné): agent 1, 3, 7;
- za `billingRouter`/`publishRouter` (fungujú aj bez auth): agent 5, 8, 9.

Pravidlá:
1. Agent vkladá riadky **iba medzi svoje dve značky**. Značky nemaže a nepresúva. Cudzí slot nemení.
2. Medzi slotmi je vždy aspoň jeden nemenný riadok, takže git zlúči vložené riadky bez konfliktu.
3. Router namontovaný na `'/'` smie mať middleware **iba na svojich cestách** (`router.use('/api/xyz/*', …)`), nikdy `router.use('*', …)` — inak zachytí všetky ďalšie routy (presne táto chyba je v PR #77, pozri plán, krok 0).
4. Auth už rieši globálny `app.use('/api/*', makeAuthMiddleware…)`; vlastný auth guard v routeri je len obrana do hĺbky.
5. Importy pre nový router pridávaj na samostatný riadok na koniec importného bloku zo `./agent/…`, `./billing/…` atď.; pri konflikte v importoch je riešenie triviálne (ponechať oba).

## src/stores/useAppStore.ts — návrh slice pre agenta 2 (kód sa v kroku 0 nemení)
`useAppStore.ts` má ~1090 riadkov, `export interface AppState` (r. 63) a jedno `create<AppState>((set, get) => ({ … }))` (r. 237–1088).

Návrh:
- Nový súbor `src/stores/slices/jobClientSlice.ts`:
  - `export interface JobClientSlice { jobTransport: 'idle' | 'streaming' | 'reconnecting' | 'polling' | 'background' | 'failed'; activeJobId: string | null; setJobTransport(...): void; cancelActiveJob(): Promise<void>; }`
  - `export const createJobClientSlice = (set, get): JobClientSlice => ({ … })` — typ `StateCreator<AppState, [], [], JobClientSlice>` zo `zustand`.
- V `useAppStore.ts` agent 2 smie zmeniť **presne 3 miesta**:
  1. import `createJobClientSlice, type JobClientSlice` (1 riadok),
  2. `export interface AppState extends JobClientSlice {` (1 riadok),
  3. `...createJobClientSlice(set, get),` ako prvý riadok v objekte `create<AppState>((set, get) => ({`.
- Existujúce `generateWithAi` a `resumeAgentJob` (z #77) agent 2 iba napojí na `jobClient.ts` (volanie), nie prepisuje; ich správanie (review/approval pred aplikovaním súborov) sa nemení.
- Agenti 6, 8, 9 do `useAppStore.ts` nezapisujú; ak potrebujú stav, vlastný slice cez BOSS.
