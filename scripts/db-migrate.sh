#!/usr/bin/env bash
# ============================================================================
# db-migrate.sh — Helm canonical, deterministic, FORWARD-ONLY migration runner.
# ----------------------------------------------------------------------------
# Reads supabase/migrations/MANIFEST and applies entries in order against the
# database named by PG* env / a --db-url, recording each in a ledger table
# (public.helm_schema_migrations) so re-runs are idempotent and drift is caught.
#
# MANIFEST lines:  <scope> <path>
#   base     = snapshot schema, applied ONLY on a FRESH database (no public.profiles)
#   forward  = forward-only migration, ALWAYS applied once (idempotent SQL)
# Blank lines and lines starting with # are ignored.
#
# Idempotency: a file already in the ledger with the SAME sha256 is skipped. A
# file whose content CHANGED after being recorded is a drift error (forward only;
# author a new migration instead of editing an applied one). base entries are
# skipped entirely once the DB is non-fresh.
#
# SAFETY: this runs ONLY what MANIFEST lists; it never runs the deprecated
# complete-setup.sql or random phase files, so a newer function body can't be
# silently clobbered. It makes NO decision about production — the operator points
# it at a target and reviews --plan first. Usage:
#   db-migrate.sh --plan         # show what would run, apply nothing
#   db-migrate.sh --apply        # apply pending entries
#   db-migrate.sh --verify       # print the ledger
# Connection: standard PG* env vars (PGHOST/PGPORT/PGDATABASE/PGUSER) or --db-url.
# ============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/supabase/migrations/MANIFEST"
MODE="${1:---plan}"
PSQL=(psql -v ON_ERROR_STOP=1 -q)
[ -n "${HELM_DB_URL:-}" ] && PSQL=(psql -v ON_ERROR_STOP=1 -q "$HELM_DB_URL")

sha() { shasum -a 256 "$1" | awk '{print $1}'; }
q() { "${PSQL[@]}" -t -A -c "$1"; }

# ledger
q "create table if not exists public.helm_schema_migrations(
     filename text primary key, sha256 text not null, applied_at timestamptz not null default now());" >/dev/null

if [ "$MODE" = "--verify" ]; then
  "${PSQL[@]}" -c "select filename, left(sha256,12) as sha, applied_at from public.helm_schema_migrations order by applied_at;"
  exit 0
fi

FRESH="no"; [ "$(q "select to_regclass('public.profiles') is null;")" = "t" ] && FRESH="yes"
echo "target fresh database: $FRESH"
echo "mode: $MODE"
echo "----------------------------------------"

applied=0; skipped=0; planned=0
while read -r scope path _; do
  [ -z "${scope:-}" ] && continue
  case "$scope" in \#*) continue;; esac
  file="$ROOT/$path"
  [ -f "$file" ] || { echo "MISSING: $path"; exit 1; }
  if [ "$scope" = "base" ] && [ "$FRESH" = "no" ]; then
    echo "skip (non-fresh, base): $path"; skipped=$((skipped+1)); continue
  fi
  want="$(sha "$file")"
  have="$(q "select sha256 from public.helm_schema_migrations where filename='$path';")"
  if [ -n "$have" ]; then
    if [ "$have" = "$want" ]; then echo "skip (already applied): $path"; skipped=$((skipped+1)); continue
    else echo "DRIFT ERROR: $path changed after it was applied (author a new forward migration)"; exit 1; fi
  fi
  if [ "$MODE" = "--plan" ]; then echo "PLAN apply: $scope $path"; planned=$((planned+1)); continue; fi
  echo "apply: $scope $path"
  "${PSQL[@]}" -1 -f "$file" >/dev/null
  q "insert into public.helm_schema_migrations(filename,sha256) values ('$path','$want')
       on conflict (filename) do update set sha256=excluded.sha256, applied_at=now();" >/dev/null
  applied=$((applied+1))
done < "$MANIFEST"
echo "----------------------------------------"
echo "applied=$applied skipped=$skipped planned=$planned"
