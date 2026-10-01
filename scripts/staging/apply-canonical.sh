#!/usr/bin/env bash
# ============================================================================
# apply-canonical.sh — guarded forward-only apply to Helm STAGING.
# ----------------------------------------------------------------------------
# PURPOSE: apply the sanctioned FORWARD hardening migrations (and only those)
#          from supabase/migrations/MANIFEST to the staging database, in order,
#          idempotently, recording each in the public.helm_schema_migrations
#          ledger with its sha256. It uses the Supabase Management API query
#          endpoint. This is the only script here that writes to the database.
#
# GUARDS :
#   * Hard-refuses the production ref; only the sanctioned staging ref is run.
#   * Runs precheck logic first and ABORTS if the DB is FRESH — base-v1 is
#     NEVER applied to an existing staging DB; only forward migrations apply.
#   * Applies ONLY the `forward` entries in MANIFEST. The `base` line is
#     skipped. No historical phase/wave/security-fix/full-schema/setup-all
#     bundle under supabase/ is ever executed.
#   * Verifies each migration's sha256 against the file and refuses on drift
#     (a file whose content changed after it was recorded in the ledger).
#
# SECRETS: SUPABASE_ACCESS_TOKEN (sbp_ PAT) is read from env at runtime and is
#          NEVER printed, logged, or written to a file.
#
# USAGE  : SUPABASE_ACCESS_TOKEN=sbp_xxx scripts/staging/apply-canonical.sh
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
head2 "Helm staging APPLY (forward-only, guarded)"
require_ref "$REF"
[ -f "$MANIFEST" ] || die "MANIFEST not found: $MANIFEST"

# ---- precheck logic: refuse a FRESH database -------------------------------
FRESH="$(mgmt_scalar "$REF" "select (to_regclass('public.profiles') is null);")"
if [ "$FRESH" = "true" ] || [ "$FRESH" = "t" ]; then
  fail "Staging database is FRESH (public.profiles is absent)."
  fail "This script applies FORWARD migrations onto an EXISTING staging schema only."
  info "Guidance: a fresh DB must first receive the base-v1 snapshot via the sanctioned"
  info "          local runner (scripts/db-migrate.sh against a DB restored from the"
  info "          prod extraction), NOT via this Management-API path. Re-run this script"
  info "          only once staging already holds the base schema (profiles present)."
  die  "ABORT: refusing to apply forward migrations to a fresh database."
fi
pass "Staging is not fresh (public.profiles present) — proceeding."

# ---- ensure ledger table exists (schema matches scripts/db-migrate.sh) -----
mgmt_query "$REF" "create table if not exists public.helm_schema_migrations(
  filename text primary key,
  sha256 text not null,
  applied_at timestamptz not null default now());" >/dev/null
pass "Ledger table public.helm_schema_migrations ensured."

# ---- iterate MANIFEST forward entries -------------------------------------
applied=0; skipped=0
while read -r scope path _; do
  [ -z "${scope:-}" ] && continue
  case "$scope" in \#*) continue;; esac
  # Only forward entries are ever applied here. base is skipped outright.
  if [ "$scope" = "base" ]; then
    info "skip (base, never applied via this path): $path"; continue
  fi
  if [ "$scope" != "forward" ]; then
    warn "skip (unknown scope '$scope'): $path"; continue
  fi

  file="$ROOT/$path"
  [ -f "$file" ] || die "MISSING migration file listed in MANIFEST: $path"
  # Refuse anything that is not under the canonical forward migrations dir.
  case "$path" in
    supabase/migrations/[0-9][0-9][0-9][0-9]_*.sql) : ;;
    *) die "REFUSING non-canonical forward path in MANIFEST: $path (only supabase/migrations/NNNN_*.sql allowed)";;
  esac

  want="$(sha_file "$file")"
  # escape single quotes for the SQL literal lookup
  esc_path="${path//\'/\'\'}"
  have="$(mgmt_scalar "$REF" "select sha256 from public.helm_schema_migrations where filename='$esc_path';")"

  if [ -n "$have" ]; then
    if [ "$have" = "$want" ]; then
      info "skip (already applied, sha match): $path"; skipped=$((skipped+1)); continue
    else
      die "DRIFT ERROR: $path changed after it was applied (ledger sha ${have:0:12} != file sha ${want:0:12}). Author a new forward migration instead of editing an applied one."
    fi
  fi

  info "apply: $path"
  SQL="$(cat "$file")"
  mgmt_query "$REF" "$SQL" >/dev/null

  esc_sha="${want//\'/\'\'}"
  mgmt_query "$REF" "insert into public.helm_schema_migrations(filename,sha256)
    values ('$esc_path','$esc_sha')
    on conflict (filename) do update set sha256=excluded.sha256, applied_at=now();" >/dev/null
  pass "applied + recorded: $path (sha ${want:0:12})"
  applied=$((applied+1))
done < "$MANIFEST"

head2 "APPLY summary"
printf '%sapplied=%s skipped=%s%s\n' "$C_BLD" "$applied" "$skipped" "$C_RST"
pass "APPLY: DONE"
