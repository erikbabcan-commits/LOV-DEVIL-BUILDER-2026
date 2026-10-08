# IndexedDB perzistencia — návrh adaptera (M0 príprava, neimplementované)

Cieľ: projekt, história verzií a VFS prežijú refresh browsera. Beží popri existujúceho
in-memory `state` systému — **neprepisuje ho**, len ho dopĺňa.

## Prečo IndexedDB a nie localStorage

- `state.snapshots` obsahujú celé HTML appky (rádovo 10–100 kB na snapshot, desiatky
  snapshotov na projekt) — localStorage limit ~5 MB by narazil rýchlo.
- Asynchrónne API neruší hlavné vlákno, podporuje versioning/upgrade cestu.
- Budúce M3+ (viac projektov, väčšie appky) si vyžaduje kvótový priestor.

## Schéma — DB `forge-builder`, verzia 1

```
forge-builder (v1)
├── store: projects        (keyPath: id)
│   └── { id, title, kind, createdAt, updatedAt, liveSnapshotId, publishedUrl, isPublic }
├── store: snapshots       (keyPath: id, index: byProject [projectId])
│   └── { id, projectId, v, prompt, html, kind, time, pinned, msg }
└── store: meta            (keyPath: key)
    └── { key: 'schemaVersion', value: 1 }
```

VFS cache (`state.vfs[snapId]`) sa persistovať **nebude** — je derivovateľná
zo `snap.html` (po M0-D3 bezstratovo). Jemné rozdiely (formátovanie) sa po
načítaní prepočítajú lenivým `filesFor()`.

## API adaptera (rozhranie, implementácia v M3)

```js
const ProjectStore = {
  open():                 Promise<DB>           // createObjectStore pri prvom spustení
  saveProject(p):         Promise<void>         // upsert do projects
  saveSnapshot(s):         Promise<void>         // upsert do snapshots
  deleteProject(id):       Promise<void>         // kaskáda: snapshots index byProject
  loadAll():              Promise<{projects, snapshots}>  // pri štarte appky
}
```

## Migrácia dát

1. **Export z existujúceho stavu (M0, hotové):** `saveState()` (demo/index.html:~3373)
   už vie serializovať celý relevantný stav (snapshots, liveHtml, liveId, publishedUrl…).
   Z neho sa odvodí exportní funkcia `exportForPersistence(state)`.
2. **Import pri štarte:** ak `meta.schemaVersion` chýba → čistá inštalácia.
   Ak existuje → načítaj projekty + snapshoty, nájdi `liveSnapshotId` v snapshots,
   nastav `state.liveHtml/liveId`, titulok projektu.
3. **Upgrade cesta (v2+):** v `onupgradeneeded` podľa `event.oldVersion` pridávaj
   nové store/indexy; nikdy nemeň existujúce keyPathy (breakeúc import by zahodil dáta).
4. **Write-through:** každé `createSnapshot()` / `manualSnapshot()` / `saveEdFile()`
   / premenovanie projektu v M3 zavolá aj `ProjectStore.save*` (debounce 500 ms
   pre saveEdFile kvôli rýchlym editáciám).

## Čo sa NEMIGRUJE v M0/M3 (out of scope)

- `state.messages` (chat) — voliteľné, až keď bude reálny AI engine (M4),
  kým je mock, história promptov je súčasťou snapshotu.
- M4–M6 mock dáta (tím, galéria, affiliate) — sú seedované, nie užívateľské.

## Akceptačné kritériá (pre M3 implementáciu)

- Refresh browsera zachováva projekt, históriu aj publikovaný stav.
- Dva projekty vedľa seba sa nemiesajú (index byProject).
- Zmazanie projektu zmaže aj jeho snapshoty (kaskáda).
- Kvóta/pretečenie = čitateľný toast, appka nepadne (try/catch v write-through).
