# Test Data Ledger — synthetic staging records (IDs only, no credentials)

Env: STAGING `xizehqgeyjcfpzrdymly`. All records synthetic, created by the automated lifecycle runs this session. **No production data.**

## Canonical completed event (reached terminal state)
- **Quote / event ID:** `6fa2a851-6a51-4cb7-9f9a-fd367dc401ff`
- **status:** `confirmed` · **lifecycle_stage:** `closed` · created 2026-09-29T12:10:39
- This is one lineage that traversed Lead → Discovery → Pricing/Version → Builder → Proposal → Approval → Payment → Planning → Tasks → Settlement → **Closure**.

## Other synthetic quotes created (recent sample)
`5dc4d862…`, `b48ba337…`, `00dec7a2…`, `a3d16f43…` (status `quote`, mid-lifecycle from per-browser lifecycle runs).

## Table counts (server truth, service-role read)
| Table | Count |
|---|---|
| leads | 271 |
| quotes | 300 |
| quotation_versions | 13 |
| event_tasks | 12 |
| quote_payments | 28 |

(event_discovery / event_plan / event_closure exist and are written per-run; count header not returned via the range probe.)

## Cleanup
Not performed. Synthetic staging records are retained for verifier review per the program's cleanup rule (§39). No unrelated staging records touched. **Never delete production data.**
