#!/usr/bin/env bash
# ============================================================================
# verify.sh — READ-ONLY post-apply verification of Helm STAGING.
# ----------------------------------------------------------------------------
# PURPOSE: confirm the staging database satisfies the app's DB contract and
#          carries the expected hardened objects, AFTER apply-canonical.sh.
#          It runs ONLY read-only queries via the Supabase Management API.
#          It performs NO writes and NO migrations.
#
# CHECKS :
#   1. Contract coverage: every RPC (rpc("name")) and table (.from("name"))
#      referenced in public/*.{js,html} exists in staging public schema.
#      Target: 80/80 RPCs, 56/56 tables (or better).
#   2. Ledger parity: helm_schema_migrations rows match the MANIFEST forward
#      entries by filename AND sha256.
#   3. Hardened-object spot checks (functions, triggers, private buckets).
#
# SAFETY : hard-refuses the production ref. SUPABASE_ACCESS_TOKEN (sbp_ PAT) is
#          read from env at runtime and is NEVER printed, logged, or stored.
#
# USAGE  : SUPABASE_ACCESS_TOKEN=sbp_xxx scripts/staging/verify.sh
# ============================================================================
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=_common.sh
source ./_common.sh

ROOT="$(repo_root)"
REF="$STAGING_REF"
MANIFEST="$ROOT/supabase/migrations/MANIFEST"

require_tools
require_token
head2 "Helm staging VERIFY (read-only)"
require_ref "$REF"

FAILED=0
mark_fail() { FAILED=1; }

# ---------------------------------------------------------------------------
# 1. CONTRACT COVERAGE
#    Extraction mirrors tests/db/contract-coverage.mjs:
#      RPCs   = rpc("name")
#      tables = .from("name")
#    over public/*.{js,html}.
# ---------------------------------------------------------------------------
head2 "1. Contract coverage (app -> staging public schema)"

RPCS="$(grep -rhoE 'rpc\("[a-zA-Z0-9_]+"' "$ROOT"/public/*.js "$ROOT"/public/*.html 2>/dev/null \
  | sed -E 's/rpc\("([a-zA-Z0-9_]+)"/\1/' | sort -u)"
TABLES="$(grep -rhoE '\.from\("[a-zA-Z0-9_]+"' "$ROOT"/public/*.js "$ROOT"/public/*.html 2>/dev/null \
  | sed -E 's/\.from\("([a-zA-Z0-9_]+)"/\1/' | sort -u)"

RPC_EXPECTED="$(printf '%s\n' "$RPCS" | grep -c . || true)"
TBL_EXPECTED="$(printf '%s\n' "$TABLES" | grep -c . || true)"

HAVE_FNS="$(mgmt_query "$REF" "select coalesce(json_agg(proname),'[]') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public';" | jq -r '.[0] | (to_entries[0].value)[]' 2>/dev/null | sort -u)"
HAVE_TBLS="$(mgmt_query "$REF" "select coalesce(json_agg(table_name),'[]') from information_schema.tables where table_schema='public';" | jq -r '.[0] | (to_entries[0].value)[]' 2>/dev/null | sort -u)"

MISS_RPC="$(comm -23 <(printf '%s\n' "$RPCS" | grep . || true) <(printf '%s\n' "$HAVE_FNS"))"
MISS_TBL="$(comm -23 <(printf '%s\n' "$TABLES" | grep . || true) <(printf '%s\n' "$HAVE_TBLS"))"
MISS_RPC_N="$(printf '%s\n' "$MISS_RPC" | grep -c . || true)"
MISS_TBL_N="$(printf '%s\n' "$MISS_TBL" | grep -c . || true)"

info "RPCs   expected=$RPC_EXPECTED present=$((RPC_EXPECTED - MISS_RPC_N)) missing=$MISS_RPC_N"
info "tables expected=$TBL_EXPECTED present=$((TBL_EXPECTED - MISS_TBL_N)) missing=$MISS_TBL_N"
if [ "$MISS_RPC_N" -eq 0 ] && [ "$MISS_TBL_N" -eq 0 ]; then
  pass "Contract coverage complete (all app RPCs + tables present in staging)."
else
  [ "$MISS_RPC_N" -gt 0 ] && fail "MISSING RPCs: $(printf '%s' "$MISS_RPC" | paste -sd, -)"
  [ "$MISS_TBL_N" -gt 0 ] && fail "MISSING tables: $(printf '%s' "$MISS_TBL" | paste -sd, -)"
  mark_fail
fi

# ---------------------------------------------------------------------------
# 2. LEDGER PARITY vs MANIFEST forward entries (by checksum)
# ---------------------------------------------------------------------------
head2 "2. Ledger parity (helm_schema_migrations vs MANIFEST forward entries)"

LEDGER_EXISTS="$(mgmt_scalar "$REF" "select (to_regclass('public.helm_schema_migrations') is not null);")"
if [ "$LEDGER_EXISTS" != "true" ] && [ "$LEDGER_EXISTS" != "t" ]; then
  fail "Ledger table public.helm_schema_migrations is absent."
  mark_fail
else
  LEDGER_JSON="$(mgmt_query "$REF" "select filename, sha256 from public.helm_schema_migrations;")"
  ledger_ok=1
  while read -r scope path _; do
    [ -z "${scope:-}" ] && continue
    case "$scope" in \#*) continue;; esac
    [ "$scope" = "forward" ] || continue
    file="$ROOT/$path"
    [ -f "$file" ] || { fail "MANIFEST lists missing file: $path"; ledger_ok=0; mark_fail; continue; }
    want="$(sha_file "$file")"
    got="$(printf '%s' "$LEDGER_JSON" | jq -r --arg p "$path" '.[] | select(.filename==$p) | .sha256' | head -1)"
    if [ -z "$got" ]; then
      fail "ledger MISSING forward entry: $path"; ledger_ok=0; mark_fail
    elif [ "$got" != "$want" ]; then
      fail "ledger CHECKSUM MISMATCH: $path (ledger ${got:0:12} != file ${want:0:12})"; ledger_ok=0; mark_fail
    else
      info "ledger OK: $path (sha ${want:0:12})"
    fi
  done < "$MANIFEST"
  [ "$ledger_ok" = 1 ] && pass "All MANIFEST forward entries present in ledger with matching checksums."
fi

# ---------------------------------------------------------------------------
# 3. HARDENED-OBJECT SPOT CHECKS
# ---------------------------------------------------------------------------
head2 "3. Hardened-object spot checks"

check_fn() {
  local name="$1"
  local n; n="$(mgmt_scalar "$REF" "select count(*)::int from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public' and p.proname='$name';")"
  if [ "${n:-0}" -ge 1 ] 2>/dev/null; then pass "function public.$name present"; else fail "function public.$name MISSING"; mark_fail; fi
}
check_trigger() {
  local name="$1"
  local n; n="$(mgmt_scalar "$REF" "select count(*)::int from pg_trigger where tgname='$name' and not tgisinternal;")"
  if [ "${n:-0}" -ge 1 ] 2>/dev/null; then pass "trigger $name present"; else fail "trigger $name MISSING"; mark_fail; fi
}

# functions
check_fn "helm_quote_total_canonical"
# triggers (functions enforcing the rules fire via these triggers)
check_trigger "enforce_pricing_total"
# quote<->org match trigger is named tg_quote_org_match or zz_quote_org_match
QOM="$(mgmt_scalar "$REF" "select count(*)::int from pg_trigger where tgname in ('tg_quote_org_match','zz_quote_org_match') and not tgisinternal;")"
if [ "${QOM:-0}" -ge 1 ] 2>/dev/null; then pass "trigger tg_quote_org_match / zz_quote_org_match present"; else fail "quote-org-match trigger MISSING (tg_quote_org_match / zz_quote_org_match)"; mark_fail; fi
check_trigger "enforce_no_overpayment"
check_trigger "tg_approval_token_expiry"
check_trigger "tg_otp_rate_limit"

# storage buckets must exist and be private (public = false)
for bucket in invite-media event-docs; do
  pub="$(mgmt_scalar "$REF" "select public from storage.buckets where id='$bucket';")"
  if [ -z "$pub" ]; then
    fail "storage bucket '$bucket' MISSING"; mark_fail
  elif [ "$pub" = "false" ] || [ "$pub" = "f" ]; then
    pass "storage bucket '$bucket' present and PRIVATE (public=false)"
  else
    fail "storage bucket '$bucket' is PUBLIC (public=$pub) — expected private"; mark_fail
  fi
done

# ---------------------------------------------------------------------------
# 4. IDEMPOTENCY NOTE (operator action)
# ---------------------------------------------------------------------------
head2 "4. Idempotency re-run note"
info "Re-run 'scripts/staging/apply-canonical.sh' now; it MUST report 'applied=0'"
info "(every forward migration already recorded with a matching sha256)."

# ---------------------------------------------------------------------------
# SUMMARY
# ---------------------------------------------------------------------------
head2 "VERIFY summary"
if [ "$FAILED" = 0 ]; then
  pass "VERIFY: PASS"
  exit 0
else
  fail "VERIFY: FAIL (see items above)"
  exit 1
fi
