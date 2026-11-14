#!/usr/bin/env bash
# Runs schema.sql (twice, to prove it is re-runnable) and rls_check.sql in a throwaway local Postgres.
set -euo pipefail
cd "$(dirname "$0")/../.."
BIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)
[ -n "$BIN" ] || { echo "PostgreSQL server binaries not found; skipping"; exit 0; }
DIR=$(mktemp -d); trap 'su_run "$BIN/pg_ctl -D $DIR/data stop -m immediate" >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT
chmod 777 "$DIR"
su_run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$1"; else bash -c "$1"; fi; }
su_run "$BIN/initdb -D $DIR/data -A trust -U postgres >/dev/null"
su_run "$BIN/pg_ctl -D $DIR/data -o '-k $DIR -p 55432 -c listen_addresses=' -l $DIR/log start -w >/dev/null"
PSQL="psql -h $DIR -p 55432 -U postgres -d postgres -v ON_ERROR_STOP=1 -q"
$PSQL -f supabase/tests/local_auth_stub.sql
$PSQL -f supabase/schema.sql
$PSQL -f supabase/schema.sql
$PSQL -At -f supabase/tests/rls_check.sql
