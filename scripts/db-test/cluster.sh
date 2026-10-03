#!/usr/bin/env bash
# Disposable local PostgreSQL 17 cluster for Helm behavioral testing.
# Lives entirely under a scratch dir; never touches staging/production.
# Usage: cluster.sh {init|start|stop|psql|reset|status} [args...]
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"
export PATH="$PGBIN:$PATH"
# macOS Homebrew PG17 aborts with "postmaster became multithreaded during startup"
# unless a concrete locale is set. C is always valid.
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
SCRATCH="${HELM_PG_SCRATCH:-/private/tmp/claude-501/-Users-koushikgoudshaganti-Desktop-Agency-Helm/c7fd02f6-a54b-4f2f-8d29-9d96fdedc5e6/scratchpad/pgcluster}"
PGDATA="$SCRATCH/data"
PORT="${HELM_PG_PORT:-55432}"
SOCK="/tmp/hpg$PORT"   # short path: unix-socket dir must be < 104 bytes
DB="${HELM_PG_DB:-helm_test}"
export PGHOST="127.0.0.1" PGPORT="$PORT" PGDATABASE="$DB" PGUSER="${PGUSER:-$(whoami)}"

cmd="${1:-status}"; shift || true
case "$cmd" in
  init)
    mkdir -p "$SOCK"
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      initdb -D "$PGDATA" -U "$PGUSER" --auth=trust -E UTF8 >/dev/null
      echo "unix_socket_directories = '$SOCK'" >> "$PGDATA/postgresql.conf"
      echo "port = $PORT" >> "$PGDATA/postgresql.conf"
      echo "listen_addresses = '127.0.0.1'" >> "$PGDATA/postgresql.conf"
      echo "initdb OK at $PGDATA"
    else echo "cluster already initialised"; fi
    ;;
  start)
    pg_ctl -D "$PGDATA" -l "$SCRATCH/server.log" -w start >/dev/null 2>&1 || true
    for i in $(seq 1 20); do pg_isready -q && break; sleep 0.3; done
    createdb "$DB" 2>/dev/null || true
    echo "started on $SOCK:$PORT db=$DB"
    ;;
  stop) pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true; echo "stopped";;
  reset)
    pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$PGDATA" "$SOCK"; echo "reset (data wiped)";;
  psql) exec psql "$@";;
  status) pg_isready && psql -c "select version();" 2>/dev/null || echo "not running";;
  *) echo "usage: cluster.sh {init|start|stop|psql|reset|status}"; exit 2;;
esac
