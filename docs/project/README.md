# Helm project documents

These documents describe Helm end to end: what it is, how it is built, how it is run, and how to hand it over. Word copies of every document are in [word/](word/).

## Suggested reading order

| # | Document | What it covers |
|---|----------|----------------|
| 1 | [PRD.md](PRD.md) | Product requirements: users, problems, features, scope |
| 2 | [DESIGN.md](DESIGN.md) | Visual and UX design system: theme, layout, components |
| 3 | [ARCHITECTURE.md](ARCHITECTURE.md) | System architecture: front end, Supabase, edge functions, hosting |
| 4 | [DATABASE.md](DATABASE.md) | Tables, RLS, RPCs, migrations |
| 5 | [API.md](API.md) | RPCs, edge functions and client store API |
| 6 | [AGENTS.md](AGENTS.md) | Rules and context for AI coding agents working in the repo |
| 7 | [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | What exists, what is next, phased plan |
| 8 | [SETUP-AND-ENVIRONMENT.md](SETUP-AND-ENVIRONMENT.md) | Local setup, environments, config and secrets |
| 9 | [INTEGRATIONS.md](INTEGRATIONS.md) | WhatsApp, Razorpay, email, photo render and other integrations |
| 10 | [TESTING-QA.md](TESTING-QA.md) | Test suites, CI checks, QA process |
| 11 | [SECURITY.md](SECURITY.md) | Security model, audits, open items |
| 12 | [CODE-REVIEW.md](CODE-REVIEW.md) | Code review standards and hotspots |
| 13 | [DEPLOYMENT.md](DEPLOYMENT.md) | How to release to staging and production |
| 14 | [MONITORING.md](MONITORING.md) | Logs, alerts, health checks |
| 15 | [PRODUCTION-AUDIT.md](PRODUCTION-AUDIT.md) | Production readiness audit and findings |
| 16 | [KT-KNOWLEDGE-TRANSFER.md](KT-KNOWLEDGE-TRANSFER.md) | Handover guide for a new owner or developer |

New team members can start with the KT document, then PRD and ARCHITECTURE.

## Working prompts 9, 11 and 15

Prompts 9, 11 and 15 in the documentation prompt set are working prompts: they are run per task (for a specific feature, review or bug) rather than producing a standing document. What they guide is covered here:

- Prompt 9 (build/feature work): [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md), [AGENTS.md](AGENTS.md)
- Prompt 11 (authentication & authorization): [SECURITY.md](SECURITY.md), [ARCHITECTURE.md](ARCHITECTURE.md), [API.md](API.md)
- Prompt 15 (debugging / root cause): [TESTING-QA.md](TESTING-QA.md), [MONITORING.md](MONITORING.md), [AGENTS.md](AGENTS.md)

The end-user manual lives separately at [../manual/USER-MANUAL.html](../manual/USER-MANUAL.html).
