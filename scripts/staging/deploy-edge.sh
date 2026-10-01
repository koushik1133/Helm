#!/usr/bin/env bash
# ============================================================================
# deploy-edge.sh — PREPARE/DEPLOY the Helm Edge Functions to STAGING only.
# ----------------------------------------------------------------------------
# Deploys the 4 edge functions and sets their secrets on the STAGING project
# (xizehqgeyjcfpzrdymly) via the Supabase CLI. PROD (nqltzgiwznphugcfhmbm) is
# hard-refused.
#
# DEFAULT = --dry-run: prints exactly what WOULD be deployed and which secret
# NAMES would be set (never their values). Nothing is sent to Supabase.
# Pass --confirm to actually deploy + set secrets.
#
# SECRETS: every value is read from the environment at runtime and piped to
# `supabase secrets set` WITHOUT being echoed, logged, or written to disk.
# Only secret NAMES are printed. Do not pass secret values on the command line.
#
# Usage:
#   scripts/staging/deploy-edge.sh                 # dry-run (safe, default)
#   scripts/staging/deploy-edge.sh --confirm       # real deploy to STAGING
#   scripts/staging/deploy-edge.sh --only send-otp # restrict to one function
#
# Required to CONFIRM-deploy:
#   SUPABASE_ACCESS_TOKEN  (sbp_ PAT; used by the CLI, never printed)
#   plus the per-function secrets listed in EDGE-SECRETS-INVENTORY.md
# ============================================================================
set -euo pipefail
export LC_ALL=C LANG=C

STAGING_REF="xizehqgeyjcfpzrdymly"
PROD_REF="nqltzgiwznphugcfhmbm"

# ---- colors ---------------------------------------------------------------
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_BLU=$'\033[34m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_BLD=""; C_RST=""; fi
info() { printf '%s[INFO]%s %s\n' "$C_BLU" "$C_RST" "$*"; }
ok()   { printf '%s[ OK ]%s %s\n' "$C_GRN" "$C_RST" "$*"; }
warn() { printf '%s[WARN]%s %s\n' "$C_YEL" "$C_RST" "$*"; }
die()  { printf '%s[FAIL]%s %s\n' "$C_RED" "$C_RST" "$*" >&2; exit 1; }
head2(){ printf '\n%s== %s ==%s\n' "$C_BLD" "$*" "$C_RST"; }

# ---- the functions we deploy (nothing else) -------------------------------
FUNCTIONS=(send-otp send-whatsapp create-payment-link razorpay-webhook)

# ---- per-function secret NAMES (mirror EDGE-SECRETS-INVENTORY.md) ----------
# SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by the platform and are
# NOT set here. Optional names are listed too; missing ones are skipped (the
# functions fall back to simulate/skip), but required ones block --confirm.
SECRETS_send_otp_required=(MSG91_AUTHKEY MSG91_SENDER MSG91_OTP_TEMPLATE_ID)
SECRETS_send_otp_optional=()

SECRETS_send_whatsapp_required=(WHATSAPP_TOKEN WHATSAPP_PHONE_ID)
SECRETS_send_whatsapp_optional=(WHATSAPP_API_VERSION ALLOWED_ORIGINS ALLOW_LOCALHOST)

SECRETS_create_payment_link_required=(RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET)
SECRETS_create_payment_link_optional=(APP_URL ALLOWED_ORIGINS ALLOW_LOCALHOST)

SECRETS_razorpay_webhook_required=(RAZORPAY_WEBHOOK_SECRET)
SECRETS_razorpay_webhook_optional=(RESEND_API_KEY RESEND_FROM MANAGER_EMAIL MANAGER_PHONE MSG91_AUTHKEY MSG91_SENDER MSG91_SMS_TEMPLATE_ID)

# map "send-otp" -> "send_otp" for the var names above
vkey() { printf '%s' "$1" | tr '-' '_'; }

# ---- arg parsing ----------------------------------------------------------
MODE="dry-run"
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --confirm) MODE="confirm" ;;
    --dry-run) MODE="dry-run" ;;
    --only) shift; ONLY="${1:-}" ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

# ---- safety: ref hard-check (refuse prod) ---------------------------------
REF="$STAGING_REF"
if [ "$REF" = "$PROD_REF" ]; then die "REFUSING: target ref is PRODUCTION ($PROD_REF)."; fi
[ "$REF" = "$STAGING_REF" ] || die "REFUSING: target ref '$REF' is not the sanctioned staging project ($STAGING_REF)."
# Defensive: refuse if the env tries to point us at prod.
if [ "${SUPABASE_STAGING_URL:-}" != "" ] && printf '%s' "$SUPABASE_STAGING_URL" | grep -q "$PROD_REF"; then
  die "REFUSING: SUPABASE_STAGING_URL contains the PROD ref ($PROD_REF)."
fi
info "Target project ref confirmed: $REF (staging)"
info "Mode: $MODE$( [ -n "$ONLY" ] && printf ' (only: %s)' "$ONLY" )"

command -v supabase >/dev/null 2>&1 || die "supabase CLI not found on PATH."

# ---- repo root + functions dir --------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FUNCS_DIR="$REPO_ROOT/supabase/functions"
[ -d "$FUNCS_DIR" ] || die "functions dir not found: $FUNCS_DIR"

# collect the set of functions to act on
TARGETS=()
for fn in "${FUNCTIONS[@]}"; do
  if [ -n "$ONLY" ] && [ "$fn" != "$ONLY" ]; then continue; fi
  [ -f "$FUNCS_DIR/$fn/index.ts" ] || die "missing function source: $FUNCS_DIR/$fn/index.ts"
  TARGETS+=("$fn")
done
[ "${#TARGETS[@]}" -gt 0 ] || die "no matching functions to deploy (check --only value)."

# ---- secrets planning (names only) ----------------------------------------
# echoes whether each required/optional secret is PRESENT in env — never values.
missing_required=0
plan_secrets_for() {
  local fn="$1" k; k="$(vkey "$fn")"
  local -n req="SECRETS_${k}_required"
  local -n opt="SECRETS_${k}_optional"
  printf '   required:\n'
  for name in "${req[@]:-}"; do
    [ -n "$name" ] || continue
    if [ -n "${!name:-}" ]; then printf '     %s = <present>\n' "$name"
    else printf '     %s = %sMISSING%s\n' "$name" "$C_RED" "$C_RST"; missing_required=$((missing_required+1)); fi
  done
  if [ "${#opt[@]:-0}" -gt 0 ] && [ -n "${opt[0]:-}" ]; then
    printf '   optional:\n'
    for name in "${opt[@]}"; do
      [ -n "$name" ] || continue
      if [ -n "${!name:-}" ]; then printf '     %s = <present>\n' "$name"
      else printf '     %s = (unset — feature simulated/skipped)\n' "$name"; fi
    done
  fi
}

# set only the secrets that are present in env, one call, values via stdin-free
# arg list that we build WITHOUT printing values.
apply_secrets_for() {
  local fn="$1" k; k="$(vkey "$fn")"
  local -n req="SECRETS_${k}_required"
  local -n opt="SECRETS_${k}_optional"
  local pairs=()
  for name in "${req[@]:-}" "${opt[@]:-}"; do
    [ -n "$name" ] || continue
    if [ -n "${!name:-}" ]; then pairs+=("$name=${!name}"); fi
  done
  if [ "${#pairs[@]}" -eq 0 ]; then warn "  no secrets present in env for $fn (skipping secrets set)"; return; fi
  info "  setting ${#pairs[@]} secret(s) for $fn (values hidden)"
  supabase secrets set --project-ref "$REF" "${pairs[@]}" >/dev/null
  ok "  secrets set for $fn"
}

head2 "PLAN"
for fn in "${TARGETS[@]}"; do
  printf '%s• %s%s\n' "$C_BLD" "$fn" "$C_RST"
  printf '   deploy: supabase functions deploy %s --project-ref %s\n' "$fn" "$REF"
  plan_secrets_for "$fn"
done

if [ "$MODE" = "dry-run" ]; then
  head2 "DRY-RUN"
  warn "No deploy performed. Re-run with --confirm to deploy to STAGING ($REF)."
  [ "$missing_required" -gt 0 ] && warn "$missing_required required secret(s) are MISSING; set them before --confirm."
  exit 0
fi

# ---- confirm path ---------------------------------------------------------
head2 "CONFIRM DEPLOY → STAGING ($REF)"
[ -n "${SUPABASE_ACCESS_TOKEN:-}" ] || die "SUPABASE_ACCESS_TOKEN (sbp_ PAT) is required to deploy. It is never printed."
case "${SUPABASE_ACCESS_TOKEN}" in sbp_*) : ;; *) die "SUPABASE_ACCESS_TOKEN must be an sbp_ PAT, not a JWT/service key." ;; esac
if [ "$missing_required" -gt 0 ]; then die "$missing_required required secret(s) missing — refusing to deploy with a broken config."; fi

for fn in "${TARGETS[@]}"; do
  head2 "deploy: $fn"
  apply_secrets_for "$fn"
  supabase functions deploy "$fn" --project-ref "$REF"
  ok "deployed $fn to staging"
done
ok "all target functions deployed to STAGING ($REF)"
