# How top SaaS companies run free trials and demo data (research, Oct 2026)

Research only. No code changes. "(unverified)" means I could not confirm it on the company's own pages, so check it before quoting it to anyone.

## 1. Company by company

| Company | Trial length | Card needed? | Same DB or separate? | Demo data and how it's removed | What happens at expiry | Source |
|---|---|---|---|---|---|---|
| **Pipedrive** | 14 days | No | Same account. Real and sample data sit side by side | Sample records start with "[Sample]". A global admin removes them all with one click (Quick help, the import page or Insights) | Access is locked until someone adds billing details. The account is deleted shortly after, and support can recover it for about 60 days | [sample data](https://support.pipedrive.com/en/article/sample-data), [expiry](https://support.pipedrive.com/en/article/what-happens-when-my-pipedrive-trial-expires), [cancel](https://support.pipedrive.com/en/article/how-can-i-cancel-my-trial) |
| **HubSpot** | 14-day trials of paid hubs on top of a free CRM (unverified) | No | Same portal. Separate sandbox portals only on Enterprise | Partners can generate industry demo data. It must be deleted by hand | Drops back to the free tier. Data is kept | [partner demo data](https://knowledge.hubspot.com/partner-tools/create-partner-demo-data) |
| **Salesforce** | Trailhead Playground: never expires while used. Developer Edition: free | No | **Separate org for each environment.** Sandboxes are copies of production and can only be made from production | Playgrounds ship with Trailhead sample data | Playground expires only if it isn't used | [dev environments](https://trailhead.salesforce.com/content/learn/modules/environments-for-developers/explore-available-developer-environments), [playground](https://trailhead.salesforce.com/content/learn/modules/trailhead_playground_management/create-a-trailhead-playground) |
| **Shopify** | Merchant trial of about 3 days, then a cheap first month (unverified). Development stores are free and unlimited for Partners | Partner dev stores: no | Separate store for each tenant. The auto-made "Quick Start" store is filled with generated test data | Generated test data lives in its own store. You delete the whole store | A dev store converts to a paid plan when it's handed to a client | [dev stores docs](https://shopify.dev/docs/api/development-stores/index), [partners blog](https://www.shopify.com/partners/blog/development-stores) |
| **Zoho CRM** | 15 days (unverified) | No | Sandbox is a **separate environment** that copies your setup. Sample mode pulls in about 10 records per module | Throw away or rebuild the sandbox. A full-data sandbox can be refreshed every 30 days. Emails sent from the sandbox are not delivered | n/a | [Marks Group guide](https://www.marksgroup.net/blog/using-the-zoho-crm-sandbox/), [Zoho full-data sandbox](https://help.zoho.com/portal/en-gb/community/topic/create-full-data-sandbox-now-in-zoho-crm-19-5-2025?page=6) |
| **Slack** | Pro trial (length varies) | No | Same workspace | No sample data. Empty workspace with tips | Cancels itself automatically and falls back to the free plan. Data is kept, with free-plan limits | [Slack help](https://slack.com/help/articles/202878523-Try-a-paid-plan-for-free) |
| **monday.com** | 14 days (unverified) | No | Same account | Templates create sample boards in your own account. You delete those boards like any others | Moves to the free plan, or a "trial expired, pick a plan" screen | [community](https://community.monday.com/t/am-i-on-a-trial-plan-or-a-free-plan-or-something-else/21626), [expired screen](https://community.monday.com/t/how-can-i-override-the-trial-has-expired-screen/81862) |
| **Notion** | Free plan plus trials of paid plans | No | Same workspace | Template pages, deleted like normal pages | Downgrades to the free plan | [downgrade](https://www.notion.com/en-gb/help/plan-downgrade) |
| **Airtable** | About 14 days | No | Same workspace | Sample bases and templates | Moves to the Free plan (also 14 days after a declined payment) | [community](https://community.airtable.com/t/was-just-notified-my-free-trial-ends-tomorrow/52779), [declined payments](https://support.airtable.com/docs/resolving-declined-airtable-payments) |
| **Freshsales** | 21 days (unverified) | No | Same account with sample records (unverified) | Remove from settings (unverified) | A closed account can be reactivated within 15 days | [cancel guide](https://subger.com/es/ua/cancel/freshsales-crm) |
| **Linear** | Free plan | No | **Separate read-only-style "Demo" workspace** next to your real one (unverified) | You never mix demo with real. You just leave the demo | n/a | [guideflow](https://www.guideflow.com/tutorial/how-to-delete-projects-on-linear) |
| **Canva** | 30-day Pro trial | **Yes** | Same account | Templates | Charges automatically unless cancelled, which causes many complaints | [Style Factory](https://www.stylefactoryproductions.com/blog/canva-free-trial), [what happens at end](https://brendacadman.com/what-happens-when-your-canva-pro-free-trial-ends/) |
| **Dubsado** (events) | 21 days, full Premier plan, no client limits | No | Same account | Sample/template forms | Pick a plan to keep going | [trial FAQ](https://help.dubsado.com/en/articles/6760620-free-trial-faq), [pricing](https://www.dubsado.com/pricing) |
| **HoneyBook** (events) | 7 days according to its own pros site. Some pages say 30 | No | Same account | Templates | Pick a plan | [HoneyBook plans](https://pros.honeybook.com/blog/blog-post/honeybook-plans), [vs Tripleseat](https://www.honeybook.com/blog/honeybook-vs-tripleseat) |
| **Tripleseat** (venues) | Sales-led demo. An old post mentions 30 days | n/a | Run by sales | Guided demo | n/a | [G2](https://www.g2.com/compare/follett-facilities-schedules-vs-tripleseat-tripleseat) |
| **Planning Pod** (events) | Free trial available, length not published | n/a | n/a | n/a | n/a | [subscribed.fyi](https://subscribed.fyi/?p=127661) |
| **Aisle Planner** | Free trial, details not confirmed | n/a | n/a | n/a | n/a | not verified |

Abuse prevention is mostly not published. In practice the common pattern is email verification before the trial starts, one trial per verified email (some limit it per domain too), and no card for B2B tools. Canva is the exception and asks for a card.

## 2. Patterns (what the best ones agree on)
1. **Small and mid-size SaaS keep one database.** Pipedrive, HubSpot, Slack, monday, Notion, Airtable, Dubsado and HoneyBook all run trials inside the same production system as paying customers. The trial is just a plan flag on the account.
2. **Separate environments are for developers and enterprises.** Salesforce sandboxes, Zoho sandbox and Shopify dev stores are separate copies, built for testing setup changes. They are not for first-time trial users.
3. **Demo data comes in two styles:**
   - *Seeded into your own account and clearly labelled* (Pipedrive "[Sample]"), with **one-click "remove all sample data"**. This is the best-documented pattern.
   - *A separate demo space* (Linear's demo workspace, Shopify Quick Start). Real data and demo data never mix.
4. **No card for B2B.** Lengths range from 7 to 21 days, with 14 the most common.
5. **At expiry, lock but keep the data** for a while (Pipedrive: locked, then deleted, recoverable for about 60 days). Or drop to a free plan where one exists.

## 3. RECOMMENDATION for Helm (plain words)

**One database, not a separate trial database.** Helm already keeps each studio's data walled off from every other studio. A trial studio is just a normal studio marked "trial, ends on date X". A second database would mean two copies of everything to maintain and secure, plus a risky move of all their data when they pay. Every company above at Helm's size uses one database.

**Demo data: do both, the safe way.**
- **A. A shared "Demo Studio" that visitors can only look at.** One studio, owned by Helm, full of realistic sample events, clients, quotes and 2D/3D layouts. Every trial user can browse it but cannot change it. This is the Linear/Shopify style. It is good for sales demos, and nobody can break it.
- **B. An optional "Load sample data" button inside their own studio.** Every sample record is tagged as sample and labelled "Sample" in the screens, and there is a **"Remove all sample data" button** that deletes only tagged records. This is the Pipedrive style. Their real clients are never touched, and sample records never feed reports or invoices.
- Start with A because it is the simplest and safest. Add B after that.

**Trial length: 8 days, no card.** Plenty of competitors run 7 to 21 days, and HoneyBook's own site says 7. Send reminders on day 5, day 7 and the last day.

**At expiry:**
- Day 8: the studio becomes **read-only**. They can log in, see and export their data, and press "Upgrade", but cannot create or edit anything. Public links such as invitation sites and quotes stop working.
- Keep their data for **30 to 60 days**, then email a warning, then delete the trial studio. Paying customers' data is never touched.
- Upgrading during that window simply removes the trial flag. Nothing gets moved or copied.

**Abuse rules:** the email must be confirmed before the trial starts. One trial per email address, and one per phone number if you collect it. Optionally block throwaway email domains. Google sign-in counts as a confirmed email.

**Sign-up email confirmation for testing:** Supabase has a "Confirm email" setting. Keep it **on in production** so every real sign-up gets a confirmation link. For testing, use the **staging** project (helm-staging) and either switch confirmation off there or confirm test users by hand in the Supabase dashboard (Authentication > Users). Don't switch it off in production just to test. Also note that Supabase's built-in email sender only allows a few emails per hour, so set up your own email sender (SMTP) before launch.
