#!/usr/bin/env bash
# scry-log-drift: is this repo's vendored scry-log AHEAD of the stage logs Worker? (log-core-hardening S4, plan row
# "CI check scry-log-drift"). Computes the vendored copy's schema hash and entry count the way scry-management's
# scripts/logs-deploy-check.sh does (scripts/scry-log-schema.mjs is that script's reader), then compares them with the
# public /healthz of the stage logs Worker, which exposes only {schema.hash, entries}, never field names.
#
#   scripts/scry-log-drift.sh [vendored-dir]        default src/lib/scry-log
#
#   same hash                                   PASS
#   vendored has MORE entries than the Worker   FAIL "deploy logs-service first"  (the Worker would drop those fields)
#   vendored has FEWER entries                  WARN: behind, re-run scry-management/lib/scry-log/sync.sh (never blocks)
#   same count, different hash                  WARN: a definition (max, pattern, version) differs; deploying cannot clear it
#   Worker has no schema hash (predates S2)     FAIL, like ahead (SCRY_LOG_UNHASHED=warn downgrades it to a warning)
#   /healthz unreachable or not JSON            PASS with a warning (a Worker outage must not block unrelated PRs)
#   vendored copy unreadable (no schema-hash.ts, typescript missing)   exit 2
#
# Limit: names are not on /healthz, so a copy that adds some entries and lacks others by the same count is not seen
# as ahead; the hash difference still prints as a warning. Needs bash, curl, jq, node and `typescript` resolvable
# from the repo root. Env: SCRY_LOGS_STAGE_HEALTHZ (default https://logs-stage.scrymore.com/healthz; tests use file://
# or a closed port), SCRY_LOG_UNHASHED=fail|warn (default fail).
set -uo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
dir=${1:-src/lib/scry-log}
url=${SCRY_LOGS_STAGE_HEALTHZ:-https://logs-stage.scrymore.com/healthz}
unhashed=${SCRY_LOG_UNHASHED:-fail}

warn() { if [[ -n ${GITHUB_ACTIONS:-} ]]; then echo "::warning title=scry-log-drift::$*"; fi; echo "scry-log-drift: WARNING: $*"; }
fail() { if [[ -n ${GITHUB_ACTIONS:-} ]]; then echo "::error title=scry-log-drift::$*"; fi; echo "scry-log-drift: FAIL: $*"; }

for d in curl jq node; do command -v "$d" >/dev/null 2>&1 || { echo "scry-log-drift: missing dependency: $d" >&2; exit 2; }; done

if ! vjson=$(node "$here/scry-log-schema.mjs" "$dir" 2>&1); then
  echo "scry-log-drift: cannot read the vendored scry-log in $dir: $(head -n 3 <<< "$vjson" | tr '\n' ' ')" >&2
  exit 2
fi
vhash=$(jq -r .hash <<< "$vjson"); ventries=$(jq -r .entries <<< "$vjson")

if ! body=$(curl -4 -fsS --max-time 10 "$url" 2>/dev/null) || ! hz=$(jq -ce 'select(type == "object")' <<< "$body" 2>/dev/null); then
  warn "could not read the stage logs Worker /healthz ($url); drift not checked (vendored hash $vhash, $ventries entries)"
  exit 0
fi
shash=$(jq -r '.schema.hash // empty' <<< "$hz"); sentries=$(jq -r '.entries // empty' <<< "$hz"); scommit=$(jq -r '.commit // "unknown"' <<< "$hz")

if [[ -z $shash || ! $sentries =~ ^[0-9]+$ ]]; then
  msg="the stage logs Worker (commit ${scommit:0:9}) predates the schema hash, so the vendored scry-log ($ventries entries, hash $vhash) is ahead of it. Deploy logs-service first."
  if [[ $unhashed == warn ]]; then warn "$msg"; exit 0; fi
  fail "$msg"; exit 1
fi
if [[ $shash == "$vhash" ]]; then
  echo "scry-log-drift: OK: vendored scry-log matches the stage logs Worker (hash $vhash, $ventries entries)"
  exit 0
fi
if (( ventries > sentries )); then
  fail "vendored scry-log is ahead of the stage logs Worker: $ventries schema entries vs $sentries (hash $vhash vs $shash, Worker commit ${scommit:0:9}). The Worker would drop the extra fields. Deploy logs-service first."
  exit 1
fi
if (( ventries < sentries )); then
  warn "vendored scry-log is behind the stage logs Worker: $ventries schema entries vs $sentries (hash $vhash vs $shash). Run scry-management/lib/scry-log/sync.sh <this repo>."
  exit 0
fi
warn "vendored scry-log has the same entry count as the stage logs Worker ($ventries) but a different hash ($vhash vs $shash): a definition or the schema version differs. Not blocking."
exit 0
