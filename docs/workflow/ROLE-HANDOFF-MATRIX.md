# Role Handoff Matrix — Helm (staging runtime)

Each boundary records the SAME canonical quote moving between roles. Verified by the lifecycle spec (server-truth after each stage) this session.

| From → To | Record | State before | Action completed | State after | Next role sees | Pass |
|---|---|---|---|---|---|---|
| (start) → Sales | lead | none | Sales creates lead | lead `new` | a lead to convert | ✅ |
| Sales → Planner | quote | lead `new` | `convert_lead_to_quote` | quote `draft` | quote to scope discovery/pricing | ✅ |
| Planner → Planner | quote | `draft` | discovery + priced version + builder + proposal publish | quote priced, proposal published, share token | client can open proposal | ✅ |
| Planner → Client | proposal/token | published | share token minted | token valid, scoped to quote | proposal + OTP approval screen | ✅ |
| Client → Planner(payment) | consent + payment | proposal published | OTP approve (single-use) then advance recorded | approved + receipt | confirmed booking | ✅ |
| Planner → Operations | plan | paid/confirmed | `set_event_plan` | venue/plan set | plannable event | ✅ |
| Operations → Worker | task + token | plan set | `assign_tasks` + worker token | task assigned | only their assigned task | ✅ |
| Worker → Manager | task/event | task assigned/accepted | worker accepts via token | task acknowledged | settlement-ready event | ✅ |
| Manager → Admin | closure | settlement pending | `close_event` (W16-02 manager authority) | terminal `closed` | completed event to audit | ✅ |
| Admin (review) | all | closed | read-only audit | consistent, one org, no orphans | — | ✅ |

**Cross-tenant boundary:** Org B attempting to read the canonical quote → **0 rows (denied)** ✅.
**Negative authorization:** client reading quotes/leads/payments → **0 rows (denied)** ✅.
