# Screenshot Manifest — Helm role workflow (staging)

All screenshots captured headless via `tests/e2e/workflow/capture.spec.mjs` against localhost→STAGING using each role's real session. Each role's capture asserted **zero production requests**. No credentials/OTP/tokens appear (auth via saved session, not visible login). Path root: `docs/workflow/screenshots/`.

| File | Role | Page | Expected | Actual | Pass |
|---|---|---|---|---|---|
| 01-admin/01-dashboard.png | admin | dashboard | full admin nav | rendered | ✅ |
| 01-admin/02-control-center.png | admin | control | users/roles/config | rendered | ✅ |
| 01-admin/03-quotes.png | admin | quotes | quote list | rendered | ✅ |
| 01-admin/04-reports.png | admin | reports | reporting | rendered | ✅ |
| 02-sales/01-dashboard.png | sales | dashboard | sales nav | rendered | ✅ |
| 02-sales/02-leads.png | sales | leads | lead pipeline | rendered | ✅ |
| 02-sales/03-crm.png | sales | crm | CRM archive | rendered | ✅ |
| 03-planner/01-dashboard.png | planner | dashboard | planner nav | rendered | ✅ |
| 03-planner/02-quotes.png | planner | quotes | quotes | rendered | ✅ |
| 03-planner/03-discovery.png | planner | discovery | discovery form | rendered | ✅ |
| 03-planner/04-proposal.png | planner | proposal | proposal editor | rendered | ✅ |
| 03-planner/05-builder.png | planner | builder | 2D/3D builder | rendered | ✅ |
| 04-client/01-dashboard.png | client | dashboard | restricted view (0 rows) | rendered | ✅ |
| 05-manager/01-dashboard.png | manager | dashboard | manager nav | rendered | ✅ |
| 05-manager/02-settlement.png | manager | settlement | settlement | rendered | ✅ |
| 05-manager/03-closure.png | manager | closure | closure/P&L | rendered | ✅ |
| 06-coordinator/01-dashboard.png | coordinator | dashboard | coordinator nav | rendered | ✅ |
| 06-coordinator/02-plan.png | coordinator | plan | planning | rendered | ✅ |
| 06-coordinator/03-resources.png | coordinator | resources | resources | rendered | ✅ |
| 07-operations/01-dashboard.png | operations | dashboard | ops nav | rendered | ✅ |
| 07-operations/02-ops.png | operations | ops | tasks/ops | rendered | ✅ |
| 07-operations/03-runsheet.png | operations | runsheet | run sheet | rendered | ✅ |
| 07-operations/04-inventory.png | operations | inventory | inventory | rendered | ✅ |
| 08-worker/01-dashboard.png | worker | dashboard | worker view | rendered | ✅ |
| 09-supervisor/01-dashboard.png | supervisor | dashboard | supervisor view | rendered | ✅ |
| 10-quality/01-dashboard.png | quality | dashboard | quality view | rendered | ✅ |
| 11-crew/01-dashboard.png | crew | dashboard | crew view | rendered | ✅ |

**Total: 27 screenshots, 11 roles.** Plus one manually-captured proof (`admin dashboard` via the live built-in browser) confirming real interactive login on staging.
