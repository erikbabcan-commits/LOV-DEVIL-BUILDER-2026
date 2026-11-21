# Rezervované čísla migrácií (LOV-DEVIL 10 epikov, krok 0)

Stav k 20. 11. 2026, schválené Erikom (t651u). Zmena len cez BOSS.

Migrácie sú SQL súbory v `server/migrations/`, aplikujú sa lexikálne (`server/db/migrate.ts`).
Posledná migrácia v `base-issue-75` (c63b9eb) je `022_private_blueprints.sql`.

| Číslo | Súbor | Vlastník | Obsah | Stav |
|---|---|---|---|---|
| 023 | `023_agent_jobs.sql` | PR #77 (8d1989a) | tabuľka `agent_jobs` (state, idempotency_key, events, error) | zmergované do `integration/base-step0` |
| 024 | `024_agent_jobs_ledger.sql` | Agent 1 | job ledger / worker, odpočet kvóty pri `succeeded` | rezervované |
| 025 | `025_billing_webhook_queue.sql` (názov podľa agenta) | Agent 5 | fronta billing webhookov, grace period, flag downgrade na `free` | rezervované |
| 026 | `026_publish_rollback_domains.sql` (názov podľa agenta) | Agent 7 | publish rollback, slug a vlastné domény | rezervované |
| 027+ | — | len cez BOSS | — | voľné |

Pravidlá:
- Nikto nepoužije číslo, ktoré mu nebolo pridelené. Ďalšie číslo pridelí BOSS.
- Migrácie musia byť idempotentné (`IF NOT EXISTS`) a otestované cez `pg-mem` (reálny Postgres/Docker až pri finálnej integrácii).
- **Pin `DATABASE_SCHEMA_SHA256` sa počas vývoja nemení.** Prepočíta ho až integrátor na konci po zmergovaní všetkých migrácií. PR #77 pin nemení (pin je hodnota v prostredí, nie v kóde); po zmergovaní 023 je produkčný pin neaktuálny, kým ho integrátor neprepočíta.
- Existujúce migrácie (001–023) sa nikdy needitujú.
