#!/usr/bin/env bash
# Tests for scripts/scry-log-drift.sh (log-core-hardening acceptance rows 32-33). Run from anywhere:
#   bash scripts/tests/scry-log-drift-test.sh
# Fake stage Workers are files read through file:// URLs; the network error is a closed local port.
set -uo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$here/../.." && pwd)
cd "$root" || exit 2
check="$root/scripts/scry-log-drift.sh"
vendored=${SCRY_LOG_DIR:-src/lib/scry-log}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
pass=0; failn=0

ok()  { pass=$((pass + 1)); echo "ok   - $1"; }
bad() { failn=$((failn + 1)); echo "FAIL - $1"; [[ -n ${2:-} ]] && sed 's/^/       /' <<< "$2"; }

vjson=$(node "$root/scripts/scry-log-schema.mjs" "$vendored") || { echo "cannot read the vendored scry-log" >&2; exit 2; }
vhash=$(jq -r .hash <<< "$vjson"); ventries=$(jq -r .entries <<< "$vjson")

# run <name> <expected rc> <expected text> <url> [env...]
run() {
  local name=$1 rc_want=$2 text=$3 url=$4 out rc; shift 4
  out=$(env SCRY_LOGS_STAGE_HEALTHZ="$url" "$@" bash "$check" "$vendored" 2>&1); rc=$?
  if [[ $rc == "$rc_want" && $out == *"$text"* ]]; then ok "$name"; else bad "$name (want rc $rc_want and \"$text\", got rc $rc)" "$out"; fi
}
healthz() { printf '{"ok":true,"service":"scry-logs","env":"staging","commit":"%s"%s}' "${1:-91fc9e0111d03641821f53136b754b28234c3a3c}" "${2:-}" > "$tmp/hz.json"; echo "file://$tmp/hz.json"; }

run "same hash passes"                 0 "OK: vendored scry-log matches" "$(healthz abc ",\"schema\":{\"version\":1,\"hash\":\"$vhash\"},\"entries\":$ventries")"
run "vendored ahead (row 32) fails"    1 "Deploy logs-service first"     "$(healthz abc ",\"schema\":{\"version\":1,\"hash\":\"0000000000000000\"},\"entries\":$((ventries - 3))")"
run "vendored behind warns, passes"    0 "behind the stage logs Worker"  "$(healthz abc ",\"schema\":{\"version\":1,\"hash\":\"0000000000000000\"},\"entries\":$((ventries + 2))")"
run "same count, other hash warns"     0 "different hash"                "$(healthz abc ",\"schema\":{\"version\":1,\"hash\":\"0000000000000000\"},\"entries\":$ventries")"
run "worker without a hash fails"      1 "predates the schema hash"      "$(healthz)"
run "worker without a hash, warn mode" 0 "predates the schema hash"      "$(healthz)" SCRY_LOG_UNHASHED=warn
run "network error (row 33) passes"    0 "could not read the stage logs Worker" "http://127.0.0.1:9/healthz"
echo 'upstream connect error' > "$tmp/html.txt"
run "non-JSON body passes with warning" 0 "could not read the stage logs Worker" "file://$tmp/html.txt"
run "missing file passes with warning" 0 "could not read the stage logs Worker" "file://$tmp/none.json"

# A copy that predates the schema hash cannot be read: exit 2 (a repo problem, not a Worker outage).
mkdir -p "$tmp/old"; cp "$vendored"/*.ts "$tmp/old/"; rm -f "$tmp/old/schema-hash.ts"
out=$(SCRY_LOGS_STAGE_HEALTHZ="http://127.0.0.1:9/healthz" bash "$check" "$tmp/old" 2>&1); rc=$?
if [[ $rc == 2 && $out == *"schema-hash.ts"* ]]; then ok "copy without schema-hash.ts exits 2"; else bad "copy without schema-hash.ts exits 2 (got rc $rc)" "$out"; fi

echo "$pass passed, $failn failed"
[[ $failn == 0 ]]
