# SEC-01 — layouts tenant-isolation test specs (NOT TESTED — staging required)

These prove `phase89-layouts-org-isolation.sql`. They **cannot** run here: no
isolated DB, no two synthetic orgs, and the local server points at production
(read-only). Author now, run on staging (see `docs/STAGING-SETUP.md`). Until then
SEC-01 is **Fixed — source/automated verified**, NOT staging verified.

Fixtures: Org A (user Aa), Org B (user Bb); rows La (owned by A), Lb (owned by B),
Lnull (legacy, org_id IS NULL).

| # | Actor | Action | Expected |
|---|-------|--------|----------|
| 1 | anon (public key) | `select * from layouts` | 0 rows (no anon policy) |
| 2 | anon | `insert into layouts …` | denied |
| 3 | anon | `update layouts …` | 0 rows affected / denied |
| 4 | anon | `delete from layouts` | 0 rows affected / denied |
| 5 | Org A | `select` | sees La only (not Lb, not Lnull) |
| 6 | Org A | `insert {name,data}` | row created, org_id auto = A (trigger) |
| 7 | Org A | `insert` with forged `org_id = B` | stored with org_id = A (trigger overrides) |
| 8 | Org A | `update Lb` (B's row) | 0 rows affected |
| 9 | Org A | `delete Lb` | 0 rows affected |
| 10 | Org A | `select`/`update`/`delete` Lnull | invisible / 0 rows (quarantined, preserved) |
| 11 | operator | `select layouts_quarantined_count()` | counts Lnull (for deliberate assignment) |

DO NOT BREAK (also assert): Org A can save, list, and reopen its own layouts
normally through store-api (`supa.from('layouts')`), and no existing row is deleted.
