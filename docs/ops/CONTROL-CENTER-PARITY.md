# Control Center parity: old tabs vs split settings

Source: `origin/main` `public/control.html` (merged at 55fde04a) plus the scripts it loads.
The split layer (`public/control-split.js`) only moves existing cards between sections; no
element, id or listener is removed. Verified in a browser on :4420 (admin, 1280 + 375 px):
every card below is shown in its section, no card is unassigned, search finds it.

| Old location (tab → card) | Key ids | New section (deep link) | Status |
|---|---|---|---|
| Pricing → Studio account | `accCard`, `accBody` | General `#general` (`#account` still works) | OK |
| Pricing → Demo data (trial-demo.js) | `tdControl` | General `#general` | OK |
| Pricing → Organization / studio + Billing details | `o_country` … `o_pin`, `o_save` | General `#general` | OK |
| Pricing → Client link name (inside org card) | `slugBox`, `o_slug`, `o_slug_save` | General `#general` | OK |
| Pricing → Subscription | `subCard`, `subBody` | Plan & billing `#billing` | OK |
| Pricing → Client links — auto-expire | `lxCard`, `lx_on`, `lx_days`, `lx_move_*`, `lx_save` | Client links & packages `#client-links` | OK |
| Pricing → Client package flow (pkg-review.js) | `pkgFlowCard` | Client links & packages `#client-links` | OK |
| Pricing → Default pricing | `pricingCard` | Pricing & coupons `#pricing` | OK |
| Pricing → Item pricing (item-pricing.js) | `itemPricingCard` | Pricing & coupons `#pricing` | OK |
| Pricing → Capacity limits | (card) | Pricing & coupons `#pricing` | OK |
| Pricing → Object & item prices | (card) | Pricing & coupons `#pricing` | OK |
| Pricing → Coupons | (card) | Pricing & coupons `#pricing` | OK |
| Pricing → Chair types / Plate types / Dishes catalog | (cards) | Menus & catalog `#menu` | OK |
| Pricing → Menu packages | `menuCard`, `menuTplList` | Menus & catalog `#menu` | OK |
| Pricing → Default layout rules ("layout reminders") | `layoutRuleList` | Layout rules `#layout-rules` | OK |
| Pricing → Import from Excel (smart-import) | (card) | Import & custom fields `#data` | OK |
| Pricing → Custom fields | `cfCard` | Import & custom fields `#data` | OK |
| User control → Team members | `um_rows`, `um_add`, `uc_q` | Users & invites `#users` | OK |
| User control → Invite by email link | `inv_add`, `inv_rows` | Users & invites `#users` | OK |
| User control → Access control matrix | `roleTabs`, `matrix` | Roles & access `#access` | OK |
| User control → Data portability / compliance | `btn-export-gdpr` | Data & compliance `#compliance` | OK |
| Notifications → Who hears about what | `nf_table`, `nf_q`, `nf_reset` | Notifications `#notifications` | OK |
| Notifications → Per-person overrides | `np_user`, `np_list` | Notifications `#notifications` | OK |
| Notifications → Event reminders (event-reminders.js, injected async) | `evrCard`, `evr_days` | Reminders & client messages `#reminders` (`#event-reminders`) | FIXED: was unassigned and not searchable |
| Notifications → Automatic client messages & WhatsApp (comms-settings.js): payment reminders, client follow-ups, inventory warning, WhatsApp forwarding | `commsCard`, `cm_*` | Reminders & client messages `#reminders` (`#client-reminders`, `#payment-reminders`, `#whatsapp`) | FIXED: was buried at the end of Notifications; hidden-until-loaded card now searchable |
| Notifications → Photo renders | `prCard`, `pr_*` | Photo renders `#renders` | OK (own section) |
| Venues tab | `venuesCard`, `vn_root` | Venues `#venues` | OK |
| Layout templates tab | `ltemplatesCard`, `st_root` | Layout templates `#layout-templates` | OK |
| Profile modal / sign-in modal | `mpModal`, `loginTitle` | unchanged (modals) | OK |
| Integrations (Razorpay/WhatsApp keys) | `integrations-settings.js` | not loaded by control.html on main either (dormant, flag-hidden) | N/A, unchanged |
| 2FA / password | not in Control Center on main (account menu / login) | n/a | N/A |

Legacy hashes kept: `#account`, `#pricing`, `#menu`, `#users`, `#notifications`, plus old preview
keys `#studio`, `#team`, `#security`, `#notify`, `#pricing-packages`.
