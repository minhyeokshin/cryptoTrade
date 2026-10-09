#!/usr/bin/env bash
set -euo pipefail
# Only pg_virtualenv -v 16 bash test/integration/journal-first-pg.sh
case "${PG_CLUSTER_CONF_ROOT:-}" in
 /tmp/pg_virtualenv.*/postgresql) ;;
 *) echo 'Refusing non-isolated PostgreSQL cluster' >&2; exit 2 ;;
esac
if [[ "${PGDATABASE:-}" != postgres || "${PGPORT:-}" == 5432 || -z "${PGPASSWORD:-}" ]]; then
 echo 'Refusing unsafe connection settings' >&2; exit 2
fi
data_dir="$(psql -XAt -v ON_ERROR_STOP=1 -c 'SHOW data_directory')"
case "$data_dir" in
 "${PG_CLUSTER_CONF_ROOT%/postgresql}"/data/*) ;;
 *) echo 'Refusing non-disposable data directory' >&2; exit 2 ;;
esac
psql -X -v ON_ERROR_STOP=1 -c 'CREATE DATABASE journal_isolated'
psql -X -q -v ON_ERROR_STOP=1 -d journal_isolated \
 -f test/integration/journal-first-fixture.sql \
 -f src/db/migrations/005_node_ws_ordering_witness.sql \
 -f src/db/migrations/008_node_ws_journal.sql
node test/integration/journal-first-pg.mjs
