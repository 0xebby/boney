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
#        ./scripts/dev-up.sh --down   (or: pnpm dev:down)  — stop a previous run and exit
set -u
cd "$(dirname "$0")/.."

DOWN=0
if [ "${1:-}" = "--down" ]; then DOWN=1; shift; fi

REPO_ROOT="$(cd .. && pwd)"
LOGS="${TMPDIR:-/tmp}/boney-dev"
# One file per started child, holding its process group id. Survives this script, by design.
PGDIR="$LOGS/pgid"
mkdir -p "$PGDIR"
HERE="$(pwd -P)"

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
REAPED=0

# Kill the whole process group of each child, not the child: `pnpm x` execs a node grandchild that
# outlives a bare `kill $pid` and keeps the port bound, so the next run fails to bind.
#
# The group id is also written to `$PGDIR`, because `cleanup` is not guaranteed to run. `setsid` detaches
# each child into its own session deliberately, so a signal aimed at the group that launched `dev:up`
# reaches this script and nothing else — and a SIGKILL there skips the trap, leaving all four processes
# reparented to init with nothing recording where they went. Those files are what `reap_strays` and
# `--down` read.
#
# The id comes from the child rather than `$!`: `setsid` forks instead of calling `setsid()` when it is
# already a process group leader, which it is whenever bash has job control on, and then `$!` names a
# wrapper that has already exited. After `setsid`, `$$` in the child *is* the leader.
start() { # start <name> <logfile> <cmd...>
  local name="$1" log="$2"; shift 2
  local pgfile i=0
  pgfile="$PGDIR/$(printf '%s' "$name" | tr -cs 'a-zA-Z0-9' '-')"
  echo "starting $name  (log: $log)"
  rm -f "$pgfile"
  setsid bash -c 'echo $$ >"$1"; shift; exec "$@"' _ "$pgfile" "$@" >"$log" 2>&1 &
  local bang=$! pg=""
  while [ ! -s "$pgfile" ] && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.1; done
  pg="$(cat "$pgfile" 2>/dev/null)"
  PIDS+=("${pg:-$bang}")
}

# True while any recorded group still has a member.
groups_alive() {
  local p
  for p in "${PIDS[@]:-}"; do kill -0 -- "-$p" 2>/dev/null && return 0; done
  return 1
}

# TERM every group, then check rather than assume. TERM is a request: `next dev` takes a moment to
# honour it, and a child still alive afterwards is one that holds its port and, for the relay loop,
# keeps reporting against the chain.
cleanup() {
  echo
  echo "shutting down…"
  local p i=0
  for p in "${PIDS[@]:-}"; do kill -- "-$p" 2>/dev/null; done
  while [ "$i" -lt 20 ] && groups_alive; do i=$((i + 1)); sleep 0.25; done
  for p in "${PIDS[@]:-}"; do kill -9 -- "-$p" 2>/dev/null; done
  rm -f "$PGDIR"/* 2>/dev/null
  wait 2>/dev/null
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

# Kills what a previous run left behind, and the reason `start` records those group ids.
#
# A leaked child is not inert. Two `relay-loop.sh` over the same targets race: each reads
# `verifiedTotalOf` and then reports an *absolute* total, so whichever one read before the other's
# report landed credits from a stale figure and overwrites it. A surviving `next-server` holds the port
# bound-but-hung, which surfaces here only as a health-check timeout on step 2.
#
# The recorded groups are exact. The command sweep after them is a backstop for a run whose files
# `/tmp` has since cleared, and is matched on this directory as well as the command: this machine runs
# other projects' dev servers, and a blanket `pkill next-server` would take those down too.
#
# `strays_here` skips this script's own ancestry, not just this script: `pnpm dev:down` runs under a
# `pnpm` and a shell, and the command line that invoked it can itself contain one of these names —
# killing that takes the caller down mid-teardown.
STRAY_PAT='next dev|next-server|relay-loop\.sh|relay-kpi-metric\.ts|ethos-stub-dev\.ts|scripts/indexer\.ts'

strays_here() {
  local p a mine=" $$ " hops=0
  a="$$"
  while [ "$hops" -lt 20 ]; do
    hops=$((hops + 1))
    a="$(awk '/^PPid:/{print $2}' "/proc/$a/status" 2>/dev/null)"
    case "$a" in "" | 0 | 1) break ;; esac
    mine="$mine$a "
  done
  for p in $(pgrep -f "$STRAY_PAT" 2>/dev/null); do
    case "$mine" in *" $p "*) continue ;; esac
    [ "$(readlink "/proc/$p/cwd" 2>/dev/null)" = "$HERE" ] || continue
    printf '%s\n' "$p"
  done
}

reap_strays() {
  REAPED=0
  local f pg p

  for f in "$PGDIR"/*; do
    [ -f "$f" ] || continue
    pg="$(cat "$f" 2>/dev/null)"
    rm -f "$f"
    case "$pg" in "" | *[!0-9]*) continue ;; esac
    kill -0 -- "-$pg" 2>/dev/null || continue
    kill -- "-$pg" 2>/dev/null && REAPED=$((REAPED + 1))
  done

  for p in $(strays_here); do
    kill "$p" 2>/dev/null && REAPED=$((REAPED + 1))
  done

  [ "$REAPED" -eq 0 ] && return 0
  echo "reaped $REAPED leftover process(es) from a previous run"
  sleep 1
  for p in $(strays_here); do kill -9 "$p" 2>/dev/null; done
}

if [ "$DOWN" = 1 ]; then
  reap_strays
  [ "$REAPED" -eq 0 ] && echo "nothing running from this directory."
  exit 0
fi

trap cleanup EXIT INT TERM

# ---- 0. reap a previous run ----------------------------------------------------------------------
# `NO_REAP=1` skips this, for the case where a process matching the sweep is deliberately running.
[ -n "${NO_REAP:-}" ] || reap_strays

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
echo "Ctrl-C to stop everything, or \`pnpm dev:down\` from another shell."
wait
