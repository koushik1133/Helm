#!/usr/bin/env bash
# ============================================================================
# _common.sh — shared helpers for the Helm STAGING deployment scripts.
# ----------------------------------------------------------------------------
# PURPOSE: one place for the Supabase Management API call, the token/ref safety
#          checks, and colored PASS/FAIL output used by precheck.sh,
#          apply-canonical.sh and verify.sh.
#
# SECRETS: the Supabase PAT is read from the environment variable
#          SUPABASE_ACCESS_TOKEN at runtime ONLY. It is NEVER printed, echoed,
#          logged, or written to any file. Do not pass it on the command line.
#
# This file is sourced, not executed. It performs no network writes on its own.
# ============================================================================
set -euo pipefail
export LC_ALL=C LANG=C

# ---- fixed project refs (safety rails) ------------------------------------
STAGING_REF="xizehqgeyjcfpzrdymly"
PROD_REF="nqltzgiwznphugcfhmbm"
MGMT_API="https://api.supabase.com/v1"

# ---- colors (fall back to plain when not a TTY) ---------------------------
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_BLU=$'\033[34m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_BLD=""; C_RST=""
fi
pass()  { printf '%s[PASS]%s %s\n' "$C_GRN" "$C_RST" "$*"; }
fail()  { printf '%s[FAIL]%s %s\n' "$C_RED" "$C_RST" "$*"; }
info()  { printf '%s[INFO]%s %s\n' "$C_BLU" "$C_RST" "$*"; }
warn()  { printf '%s[WARN]%s %s\n' "$C_YEL" "$C_RST" "$*"; }
head2() { printf '\n%s== %s ==%s\n' "$C_BLD" "$*" "$C_RST"; }
die()   { fail "$*"; exit 1; }

# ---- required tooling -----------------------------------------------------
require_tools() {
  for t in curl jq shasum; do
    command -v "$t" >/dev/null 2>&1 || die "required tool not found on PATH: $t"
  done
}

# ---- token presence + sbp_ PAT (not JWT) format check ---------------------
# Exits 2 if the token looks like a JWT; the Management API needs an sbp_ PAT.
require_token() {
  [ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || die "SUPABASE_ACCESS_TOKEN env var is required (supply the sbp_ PAT ephemerally, e.g. 'SUPABASE_ACCESS_TOKEN=sbp_... scripts/staging/precheck.sh'). It is never printed or stored."
  case "$SUPABASE_ACCESS_TOKEN" in
    eyJ*.*.*|*.*.* )
      fail "SUPABASE_ACCESS_TOKEN looks like a JWT. The Supabase Management API requires a personal access token (sbp_...), not a JWT / service_role key."
      exit 2 ;;
    sbp_* )
      : ;;  # good
    * )
      fail "SUPABASE_ACCESS_TOKEN is not in the expected sbp_ PAT format. Generate a personal access token at https://supabase.com/dashboard/account/tokens"
      exit 2 ;;
  esac
}

# ---- target ref hard-check (refuse production) ----------------------------
# Usage: require_ref "$REF"
require_ref() {
  local ref="${1:-}"
  [ -n "$ref" ] || die "no target project ref provided"
  if [ "$ref" = "$PROD_REF" ]; then
    die "REFUSING: target ref '$ref' is PRODUCTION ($PROD_REF). These staging scripts must never touch production."
  fi
  if [ "$ref" != "$STAGING_REF" ]; then
    die "REFUSING: target ref '$ref' is not the sanctioned staging project ($STAGING_REF)."
  fi
  info "Target project ref confirmed: $ref (staging)"
}

# ---- Management API query helper ------------------------------------------
# mgmt_query <ref> <sql>  -> prints the raw JSON array of rows on stdout.
# The Authorization header carries the PAT; it is passed via an argument to
# curl but never echoed by this script. Fails hard on HTTP/transport error.
mgmt_query() {
  local ref="$1" sql="$2" resp http body
  local payload; payload="$(jq -nc --arg q "$sql" '{query:$q}')"
  resp="$(curl -sS -w $'\n%{http_code}' \
    -X POST "$MGMT_API/projects/$ref/database/query" \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$payload")" || die "Management API request failed (network/transport error)"
  http="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  if [ "$http" != "200" ]; then
    # Surface the API error message but never the token.
    local msg; msg="$(printf '%s' "$body" | jq -r '.message // .error // .msg // empty' 2>/dev/null || true)"
    die "Management API returned HTTP $http${msg:+: $msg}"
  fi
  printf '%s' "$body"
}

# mgmt_scalar <ref> <sql>  -> first column of the first row, as plain text.
mgmt_scalar() {
  mgmt_query "$1" "$2" | jq -r '(.[0] // {}) | to_entries[0].value // ""'
}

# sha256 of a file (bare hex).
sha_file() { shasum -a 256 "$1" | awk '{print $1}'; }

# Repo root (scripts/staging/ -> repo root is two levels up).
repo_root() { cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd; }
