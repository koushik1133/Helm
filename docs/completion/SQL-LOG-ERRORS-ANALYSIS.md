# Analysis: the two Postgres log errors (42809 / 42725)

Your prod logs showed `42809 "array_agg is an aggregate function"` and `42725 "operator is not unique: text || char"`. **Both are schema-introspection / tooling noise, not Helm application bugs.** Verified on staging 2026-09-29.

## 42809 — `"array_agg" is an aggregate function`
- Raised by `pg_get_functiondef(oid)` when the oid is an **aggregate** (like the built-in `array_agg`). Reproduced exactly by running `pg_get_functiondef` across `pg_proc` without filtering `prokind='f'`.
- Source: schema introspection — the Supabase dashboard's **Functions** page, the Supabase **MCP server / agent-skills**, or audit queries enumerating functions. Not Helm at runtime.
- Helm's own `array_agg` usage (`queue_nurture_greeting`: `select array_agg(url order by seq, created_at) into v_photos`) is valid and compiles.

## 42725 — `operator is not unique: text || char`
- The Postgres **system catalogs** expose `"char"`-typed columns (`pg_class.relkind`, `pg_proc.prokind`, `pg_attribute.attidentity`, …). An introspection query concatenating one of these (`… || relkind`) triggers this ambiguity.
- Source: same class of dashboard/tooling catalog queries. Not Helm.
- Proof Helm is clean: every column used in a Helm `||` concatenation (`event_activity`, `create_quote`, `convert_lead_to_quote`, `rebrand_quote_code`) is **text** (checked `information_schema.columns`); **no** app function casts to `char`/`character(n)`. `convert_lead_to_quote`/`create_quote` run in the lifecycle suite (pass); `event_activity` compiles and reaches its org-check.

## Action
**None required in Helm.** These are benign artifacts of tools introspecting the schema. If you want them out of the logs, reduce dashboard/introspection activity or filter logs by `application_name`. No migration, no code change.
