#!/usr/bin/env bash
# ============================================================================
# precheck.sh — READ-ONLY staging deployment precheck (Supabase Management API).
# ----------------------------------------------------------------------------
# PURPOSE: inspect the staging database BEFORE any apply, so the operator knows
#          what is there. It runs ONLY read-only queries (counts, catalog
#          lookups, ledger listing). It performs NO writes, NO migrations.
#
# SAFETY : hard-refuses the production ref; only the sanctioned staging ref is
#          allowed. The SUPABASE_ACCESS_TOKEN (sbp_ PAT) is read from the
#          environment at runtime and is NEVER printed, logged, or written to
#          a file. Supply it ephemerally for the single command.
#
# OUTPUT : prints a PRECHECK summary and APPENDS a dated "Live precheck"
#          section to STAGING-PRECHECK.md (existing content is preserved).
#
# USAGE  : SUPABASE_ACCESS_TOKEN=sbp_xxx scripts/staging/precheck.sh
# ============================================================================
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=_common.sh
source ./_common.sh

ROOT="$(repo_root)"
REF="$STAGING_REF"
OUT="$ROOT/STAGING-PRECHECK.md"

require_tools
require_token
head2 "Helm staging PRECHECK (read-only)"
require_ref "$REF"

# ---- read-only queries ----------------------------------------------------
TABLE_COUNT="$(mgmt_scalar "$REF" "select count(*)::int from information_schema.tables where table_schema='public' and table_type='BASE TABLE';")"
ROUTINE_COUNT="$(mgmt_scalar "$REF" "select count(*)::int from information_schema.routines where routine_schema='public';")"
LEDGER_EXISTS="$(mgmt_scalar "$REF" "select (to_regclass('public.helm_schema_migrations') is not null);")"
FRESH="$(mgmt_scalar "$REF" "select (to_regclass('public.profiles') is null);")"

LEDGER_ROWS=""
LEDGER_COUNT="0"
if [ "$LEDGER_EXISTS" = "true" ] || [ "$LEDGER_EXISTS" = "t" ]; then
  LEDGER_JSON="$(mgmt_query "$REF" "select filename, sha256, applied_at from public.helm_schema_migrations order by applied_at, filename;")"
  LEDGER_COUNT="$(printf '%s' "$LEDGER_JSON" | jq 'length')"
  LEDGER_ROWS="$(printf '%s' "$LEDGER_JSON" | jq -r '.[] | "  - \(.filename)  sha=\(.sha256[0:12])  at=\(.applied_at)"')"
fi

# ---- summary --------------------------------------------------------------
head2 "PRECHECK summary"
info  "public BASE TABLE count : $TABLE_COUNT"
info  "public routines count   : $ROUTINE_COUNT"
if [ "$LEDGER_EXISTS" = "true" ] || [ "$LEDGER_EXISTS" = "t" ]; then
  pass "helm_schema_migrations ledger present ($LEDGER_COUNT row(s))"
  [ -n "$LEDGER_ROWS" ] && printf '%s\n' "$LEDGER_ROWS"
else
  warn "helm_schema_migrations ledger NOT present (apply-canonical.sh will create it)"
fi
if [ "$FRESH" = "true" ] || [ "$FRESH" = "t" ]; then
  FRESH_TXT="yes"
  warn "database appears FRESH (public.profiles is absent)"
  warn "apply-canonical.sh will ABORT on a fresh DB: it applies forward migrations only, never base-v1, onto an existing staging schema."
else
  FRESH_TXT="no"
  pass "database is NOT fresh (public.profiles exists) — forward migrations can apply"
fi

# ---- append dated section to STAGING-PRECHECK.md ---------------------------
STAMP="$(date -u '+%Y-%m-%d %H:%M:%SZ')"
{
  printf '\n---\n\n'
  printf '## Live precheck — %s\n\n' "$STAMP"
  printf -- '- Target project ref: `%s` (staging)\n' "$REF"
  printf -- '- public BASE TABLE count: **%s**\n' "$TABLE_COUNT"
  printf -- '- public routines count: **%s**\n' "$ROUTINE_COUNT"
  printf -- '- helm_schema_migrations ledger present: **%s** (rows: %s)\n' \
    "$([ "$LEDGER_EXISTS" = "true" ] || [ "$LEDGER_EXISTS" = "t" ] && echo yes || echo no)" "$LEDGER_COUNT"
  printf -- '- database fresh (profiles absent): **%s**\n' "$FRESH_TXT"
  if [ -n "$LEDGER_ROWS" ]; then
    printf '\nApplied migrations (ledger):\n\n'
    printf '%s\n' "$LEDGER_ROWS" | sed 's/^  - /- /'
  fi
} >> "$OUT"
info "Appended 'Live precheck — $STAMP' section to $OUT"

head2 "PRECHECK: DONE"
