#!/usr/bin/env bash
# Brings up the whole Base Sepolia dev fixture in the one order that works.
#
# Four processes, and the order between them is not cosmetic:
#
#   1. ethos stub   — must be listening before Next serves a request, because the profile routes are
#                     read on the server side. Started first and health-checked, not slept on.
#   2. next dev     — the app.
#   3. relay        — ONE synchronous pass, then a loop in the background. This has to precede the
#                     indexer: a gated KPI's ceiling is 0 until the relayer has observed, and a report
#                     that lands first *succeeds and credits nothing*, with no revert to surface it.
#                     Getting this backwards is silent, which is why it is sequenced here.
#   4. indexer      — one pass, after the ceiling is up.
#
# The stub is not optional. Without it every wallet's score resolves against the real upstreams, the
# dev wallet is unclaimed on Ethos, and the promoter directory renders empty.
#
# Usage: ./scripts/dev-up.sh          (or: pnpm dev:up)
set -u
cd "$(dirname "$0")/.."

REPO_ROOT="$(cd .. && pwd)"
LOGS="${TMPDIR:-/tmp}/boney-dev"
mkdir -p "$LOGS"

# publicnode, not sepolia.base.org — the latter 502s often enough that a scan rarely finishes.
RPC="${RPC:-$(command grep -E '^NEXT_PUBLIC_BASE_SEPOLIA_RPC=' .env.local 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ')}"
RPC="${RPC:-https://base-sepolia-rpc.publicnode.com}"
INTERVAL="${INTERVAL:-120}"

# Next 16 permits one dev server per directory, and this machine runs other projects' servers.
# `PORT=3001 ./scripts/dev-up.sh` moves the app when 3000 is already taken.
PORT="${PORT:-3000}"

# Reads a var out of a dotenv file without sourcing it — sourcing would execute whatever is in there
# and would also clobber this shell's own RPC/INTERVAL.
from_env_file() { # from_env_file <file> <var>
  [ -f "$1" ] || return 1
  local line
  line=$(command grep -E "^\s*$2\s*=" "$1" | tail -1) || return 1
  printf '%s' "$line" | cut -d= -f2- | tr -d '"'"'"' ' | command grep -q . || return 1
  printf '%s' "$line" | cut -d= -f2- | tr -d '"'"'"' '
}

# The relayer key, in the order the relay itself would find it.
#
# `REPORTER_PRIVATE_KEY` and not `PRIVATE_KEY`: the reporter is meant to be a different account from
# the project, since the whole point is an independent observation. `relay-kpi-metric.ts` already reads
# process env then the repo-root `.env`, so the only thing this adds is knowing *whether* a key exists
# — steps 3 and 4 are skipped rather than failing twice a minute when there is none. `BONEY_RELAYER_KEY`
# is accepted because that is the name the walkthrough exports.
#
# Note for anyone exporting it in a terminal: an `export` only reaches processes that terminal starts.
# Putting it in the repo-root `.env` is what makes it survive.
RELAYER_KEY="${REPORTER_PRIVATE_KEY:-${BONEY_RELAYER_KEY:-$(from_env_file "$REPO_ROOT/.env" REPORTER_PRIVATE_KEY || true)}}"

PIDS=()
# Kill the whole process group of each child, not the child: `pnpm x` execs a node grandchild that
# outlives a bare `kill $pid` and keeps the port bound, so the next run fails to bind.
cleanup() {
  echo
  echo "shutting down…"
  for p in "${PIDS[@]:-}"; do kill -- "-$p" 2>/dev/null; done
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

start() { # start <name> <logfile> <cmd...>
  local name="$1" log="$2"; shift 2
  echo "starting $name  (log: $log)"
  setsid "$@" >"$log" 2>&1 &
  PIDS+=("$!")
}

waitfor() { # waitfor <name> <url> <seconds>
  local name="$1" url="$2" limit="$3" i=0
  while [ "$i" -lt "$limit" ]; do
    if curl -sf -o /dev/null "$url"; then echo "  $name ready"; return 0; fi
    i=$((i + 1)); sleep 1
  done
  echo "  $name did NOT come up within ${limit}s — check its log" >&2
  return 1
}

# ---- 1. ethos stub -------------------------------------------------------------------------------
start "ethos stub" "$LOGS/ethos-stub.log" pnpm ethos:stub:dev
waitfor "ethos stub" "http://127.0.0.1:8787/health" 30 || exit 1

# ---- 2. next dev ---------------------------------------------------------------------------------
start "next dev" "$LOGS/next-dev.log" pnpm dev --port "$PORT"
waitfor "next dev" "http://localhost:$PORT/" 90 || exit 1

# ---- 3. relay, then 4. indexer -------------------------------------------------------------------
if [ -n "$RELAYER_KEY" ]; then
  export REPORTER_PRIVATE_KEY="$RELAYER_KEY"
  echo "relay: first pass (blocking — the indexer must not report before this lands)…"
  RPC="$RPC" ./scripts/relay-loop.sh --once | tee "$LOGS/relay-once.log"
  # An all-ungated fixture has nothing to relay, and a loop started over an empty target list would
  # leave a dead pid in `PIDS` for `cleanup` to signal.
  if command grep -q 'no gated KPIs' "$LOGS/relay-once.log"; then
    echo "  not starting the relay loop — nothing to relay."
  else
    start "relay loop" "$LOGS/relay-loop.log" env RPC="$RPC" REPORTER_PRIVATE_KEY="$RELAYER_KEY" \
      ./scripts/relay-loop.sh "$INTERVAL"
  fi

  echo "indexer: one pass…"
  pnpm index --rpc "$RPC" 2>&1 | command grep -vE 'scanning [0-9]+/|reading [0-9]+/' || true
else
  echo
  echo "No relayer key found — skipping relay + indexer."
  echo "  Looked at: \$REPORTER_PRIVATE_KEY, \$BONEY_RELAYER_KEY, $REPO_ROOT/.env"
  echo "  The app is fully usable, but no campaign progress is reported."
  echo "  To enable, add to $REPO_ROOT/.env:   REPORTER_PRIVATE_KEY=0x..."
fi

echo
echo "up:  app http://localhost:$PORT   stub http://127.0.0.1:8787"
echo "logs: $LOGS"
echo "Ctrl-C to stop everything."
wait
