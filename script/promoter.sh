#!/usr/bin/env bash
# Drive the promoter side of a Boney campaign from the command line.
#
#   ./script/promoter.sh status  <campaign>
#   ./script/promoter.sh join    <campaign>
#   ./script/promoter.sh touch   <campaign> [--user SEED]
#   ./script/promoter.sh report  <campaign> <kpi> <total> [--user ADDR]
#   ./script/promoter.sh settle  <campaign> <kpi>
#   ./script/promoter.sh run     <campaign> <kpi> <total> [--user SEED]
#
# `run` is the whole flow: join (skipped when already joined) -> store a signed
# touch -> credit the user's cumulative total -> push settlement. The others are
# the same steps individually, for when only one of them needs redoing.
#
# Two keys, two roles, both read from the repo-root .env:
#   ETHOS_PK     the promoter. Joins, and receives the tier payouts.
#   PRIVATE_KEY  the project. Relays touches and is the only address (besides the
#                oracle) that `reportUserAction` accepts. `run` fails early when it
#                is not the campaign's `project`.
#
# The user whose actions get credited is a throwaway wallet derived from a seed
# string, so a given seed always yields the same address and re-running is
# idempotent rather than scattering attribution across new wallets. It never needs
# gas: it only signs, and the project relays.
#
# Addresses are read off the campaign itself (`attributionRegistry()` and friends
# are public immutables), so there is nothing to configure per deployment beyond
# the RPC.
#
# Env: RPC_URL (default Base Sepolia), CHAIN_ID (default 84532), USER_SEED,
#      ENV_FILE (default ./.env).
#
# Exit codes: 0 ok, 1 usage error, 2 chain/RPC failure, 3 refused by the contract.
set -uo pipefail

RPC="${RPC_URL:-https://sepolia.base.org}"
CHAIN_ID="${CHAIN_ID:-84532}"
ENV_FILE="${ENV_FILE:-$(dirname "$0")/../.env}"
SEED="${USER_SEED:-boney-demo-user-1}"
USER_ADDR=""

usage() {
  sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

die() { printf 'promoter: %s\n' "$1" >&2; exit "${2:-1}"; }

# Strip cast's type annotations: it prints large numbers as "250000 [2.5e5]".
clean() { printf '%s' "${1%% *}"; }

# Wei -> whole tokens, for display only.
#
# Delegated to `cast to-unit` rather than done in bash: a 5,000-token pool is 5e21
# wei, which overflows bash's signed 64-bit arithmetic and silently prints a small
# wrong number instead of failing.
tokens() {
  local wei; wei=$(clean "$1")
  [ -n "$wei" ] || { printf '?'; return; }
  printf '%s' "$(cast to-unit "$wei" ether 2>/dev/null | cut -d. -f1)"
}

# All reads pin the same block. Base's public RPC load-balances across nodes that
# are not always at the same height, and an unpinned read moments after a send can
# land on one still a block behind — which reads as the transaction having silently
# done nothing. Pinning makes a stale answer impossible rather than unlikely.
BLOCK=""
pin_block() { BLOCK=$(cast block-number --rpc-url "$RPC" 2>/dev/null); }

rd() {
  local out
  out=$(cast call "$@" --rpc-url "$RPC" ${BLOCK:+--block "$BLOCK"} 2>&1)
  [ $? -eq 0 ] || { printf 'promoter: read failed: %s\n' "$out" >&2; return 1; }
  clean "$out"
}

# As rd, but keeps the whole answer. Tuples and arrays contain spaces, which the
# scalar cleaner would chop at the first one.
rd_raw() {
  local out
  out=$(cast call "$@" --rpc-url "$RPC" ${BLOCK:+--block "$BLOCK"} 2>&1)
  [ $? -eq 0 ] || { printf 'promoter: read failed: %s\n' "$out" >&2; return 1; }
  printf '%s' "$out"
}

# Custom errors arrive as raw calldata, so a refusal otherwise prints a hex blob
# that says nothing about which invariant refused. Only the errors this script can
# actually provoke are listed — anything else falls back to the raw message.
ERRORS=(
  'InsufficientReputation(uint256,uint256)'
  'UnreachableReputation(uint256,uint256)'
  'AlreadyJoined()'
  'NotJoined()'
  'NotReporter()'
  'WrongStatus(uint8)'
  'NoAttribution(address)'
  'NonMonotonic(uint256,uint256)'
  'OutsideWindow(uint64,uint64)'
  'NotFunded(uint256,uint256)'
  'UnknownKpi(uint256)'
  'AggregateKpi(uint256)'
  'TouchExpired(uint64,uint64)'
  'TouchTooLong(uint64,uint64)'
  'TouchNotNewer(uint64,uint64)'
  'TouchNotYetValid(uint64,uint64)'
  'PromoterNotRegistered(address,bytes32)'
  'InvalidSignature()'
)

decode_error() {
  local blob="$1" data sel sig types args
  data=$(printf '%s' "$blob" | grep -oE '0x[0-9a-fA-F]{8,}' | tail -1)
  [ -n "$data" ] || return 1
  sel="${data:0:10}"

  for sig in "${ERRORS[@]}"; do
    [ "$(cast sig "$sig" 2>/dev/null)" = "$sel" ] || continue
    types="${sig#*(}"; types="${types%)}"
    if [ -z "$types" ]; then printf '%s' "${sig%%(*}"; return 0; fi
    # Strip cast's "[2.4e4]" annotations and join the values back onto one line.
    args=$(cast abi-decode "e()($types)" "0x${data:10}" 2>/dev/null \
      | sed 's/ \[[^]]*\]//' | paste -sd, -)
    printf '%s(%s)' "${sig%%(*}" "$args"
    return 0
  done
  return 1
}

# Simulate, then send. The simulation is what turns a bare "execution reverted"
# into the actual custom error (InsufficientReputation, NotReporter, ...), so it
# runs first and aborts the send when it fails.
#
# The retry is not belt-and-braces: this RPC intermittently returns an empty body
# for a send that was never broadcast. Retrying a *reverting* call is pointless, so
# only a send whose simulation passed is retried, and each attempt re-checks the
# receipt rather than assuming the previous one failed.
send() {
  local label="$1" key="$2"; shift 2
  local sim
  sim=$(cast call "$@" --from "$(cast wallet address --private-key "$key")" --rpc-url "$RPC" 2>&1)
  if [ $? -ne 0 ]; then
    printf '  %-22s refused: %s\n' "$label" "$(decode_error "$sim" || printf '%s' "$(printf '%s' "$sim" | tail -1)")" >&2
    return 3
  fi

  local attempt out status
  for attempt in 1 2 3; do
    out=$(cast send "$@" --private-key "$key" --rpc-url "$RPC" 2>&1)
    status=$(printf '%s' "$out" | grep -E '^status' | head -1 | grep -o '[01]' | head -1)
    if [ "$status" = 1 ]; then
      printf '  %-22s ok   %s\n' "$label" \
        "$(printf '%s' "$out" | grep -E '^transactionHash' | awk '{print $2}')"
      return 0
    fi
    [ "$attempt" -lt 3 ] && sleep 3
  done

  printf '  %-22s failed after 3 attempts: %s\n' "$label" "$(printf '%s' "$out" | tail -1)" >&2
  return 2
}

# Throwaway user for a seed. Deterministic so re-running credits the same wallet.
user_key() { cast keccak "$SEED"; }
user_addr() {
  [ -n "$USER_ADDR" ] && { printf '%s' "$USER_ADDR"; return; }
  cast wallet address --private-key "$(user_key)"
}

load_env() {
  [ -f "$ENV_FILE" ] || die "no env file at $ENV_FILE" 1
  set -a; . "$ENV_FILE"; set +a
  [ -n "${ETHOS_PK:-}" ] || die "ETHOS_PK not set in $ENV_FILE" 1
  [ -n "${PRIVATE_KEY:-}" ] || die "PRIVATE_KEY not set in $ENV_FILE" 1
  PROMOTER=$(cast wallet address --private-key "$ETHOS_PK")
  PROJECT_ADDR=$(cast wallet address --private-key "$PRIVATE_KEY")
}

require_campaign() {
  printf '%s' "$1" | grep -qiE '^0x[0-9a-f]{40}$' || die "not an address: $1" 1
  AR=$(rd "$1" 'attributionRegistry()(address)') || exit 2
  [ -n "$AR" ] || die "no campaign at $1 (is the RPC on chain $CHAIN_ID?)" 2
  REP=$(rd "$1" 'reputationRegistry()(address)')
  TOKEN=$(rd "$1" 'token()(address)')
  ONCHAIN_PROJECT=$(rd "$1" 'project()(address)')
}

cmd_status() {
  local c="$1"
  pin_block; require_campaign "$c"

  local status min score pid now start end pool kpis
  status=$(rd "$c" 'status()(uint8)')
  min=$(rd "$c" 'minReputation()(uint256)')
  score=$(rd "$REP" 'scoreOf(address)(uint256)' "$PROMOTER")
  pid=$(rd "$c" 'promoterIdOf(address)(bytes32)' "$PROMOTER")
  start=$(rd "$c" 'startTime()(uint64)'); end=$(rd "$c" 'endTime()(uint64)')
  pool=$(rd "$c" 'remainingPool()(uint256)')
  kpis=$(rd "$c" 'kpiCount()(uint256)')
  now=$(cast block latest --rpc-url "$RPC" --field timestamp)

  local names=(Pending Active Paused Ended Cancelled)
  printf 'campaign   %s  (block %s)\n' "$c" "$BLOCK"
  printf '  status         %s\n' "${names[$status]:-$status}"
  printf '  project        %s%s\n' "$ONCHAIN_PROJECT" \
    "$([ "$ONCHAIN_PROJECT" = "$PROJECT_ADDR" ] && printf ' (yours)' || printf ' (NOT your PRIVATE_KEY — report will be refused)')"
  printf '  window         %s -> %s%s\n' "$start" "$end" \
    "$([ "$now" -gt "$end" ] && printf ' CLOSED' || printf " (%sh left)" "$(( (end - now) / 3600 ))")"
  printf '  gate           %s   your score %s%s\n' "$min" "$score" \
    "$([ "$score" -ge "$min" ] && printf ' — clears' || printf ' — SHORT')"
  printf '  joined         %s\n' \
    "$([ "$pid" = "0x0000000000000000000000000000000000000000000000000000000000000000" ] && printf 'no' || printf '%s' "$pid")"
  printf '  pool left      %s tokens (%s)\n' "$(tokens "$pool")" "$TOKEN"

  local i prog settled
  for i in $(seq 0 $((kpis - 1))); do
    prog=$(rd "$c" 'progressOf(address,uint256)(uint256)' "$PROMOTER" "$i")
    settled=$(rd "$c" 'settledTiersOf(address,uint256)(uint256)' "$PROMOTER" "$i")
    printf '  kpi%-2s          progress %-8s tiers settled %s\n' "$i" "$prog" "$settled"
    printf '                 tiers %s\n' "$(rd_raw "$c" 'tiers(uint256)((uint256,uint256)[])' "$i")"
  done
  printf '  demo user      %s (seed "%s")\n' "$(user_addr)" "$SEED"
}

cmd_join() {
  local c="$1"
  pin_block; require_campaign "$c"

  local pid; pid=$(rd "$c" 'promoterIdOf(address)(bytes32)' "$PROMOTER")
  if [ "$pid" != "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
    printf '  %-22s already joined (%s)\n' join "$pid"
    return 0
  fi
  send join "$ETHOS_PK" "$c" 'join()' || return $?
}

# Sign a Touch as the demo user and relay it from the project.
#
# `cast wallet sign --data` MUST be given the payload with --from-file. Handed the
# JSON inline it signs it as an opaque string, producing a well-formed signature
# over the wrong digest — storeTouch then reverts InvalidSignature with nothing to
# suggest the payload was the problem.
cmd_touch() {
  local c="$1"
  pin_block; require_campaign "$c"

  local pid; pid=$(rd "$c" 'promoterIdOf(address)(bytes32)' "$PROMOTER")
  [ "$pid" = "0x0000000000000000000000000000000000000000000000000000000000000000" ] &&
    die "not joined yet — run join first" 3

  local u now max exp prev
  u=$(user_addr)
  now=$(cast block latest --rpc-url "$RPC" --field timestamp)
  max=$(rd "$AR" 'maxTouchDuration()(uint64)')

  # Half the allowed horizon: long enough to outlive the campaign in practice,
  # short enough that a clock skew between signing and mining cannot trip
  # TouchTooLong at the boundary.
  exp=$((now + max / 2))

  # LAST_TOUCH orders by the user's own clock and rejects a touch that is not
  # strictly newer. Re-touching within the same second — or against a chain whose
  # timestamp has not moved since the last one — needs the clock nudged past the
  # stored value, so read it rather than assuming `now` is ahead.
  prev=$(rd_raw "$AR" 'touchOf(address,address)((address,bytes32,uint64,uint64))' "$c" "$u" 2>/dev/null)
  local prev_signed
  prev_signed=$(printf '%s' "$prev" | tr ',' '\n' | sed -n '3p' | grep -oE '[0-9]+' | head -1)
  if [ -n "$prev_signed" ] && [ "$now" -le "$prev_signed" ]; then
    now=$((prev_signed + 1))
  fi

  local payload; payload=$(mktemp)
  cat > "$payload" <<EOF
{"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],"Touch":[{"name":"campaign","type":"address"},{"name":"promoterId","type":"bytes32"},{"name":"signedAt","type":"uint64"},{"name":"expiresAt","type":"uint64"}]},"primaryType":"Touch","domain":{"name":"Boney Attribution","version":"1","chainId":$CHAIN_ID,"verifyingContract":"$AR"},"message":{"campaign":"$c","promoterId":"$pid","signedAt":$now,"expiresAt":$exp}}
EOF
  local sig; sig=$(cast wallet sign --private-key "$(user_key)" --data --from-file "$payload")
  rm -f "$payload"
  [ -n "$sig" ] || die "could not sign the touch payload" 2

  send "touch ${u:0:10}" "$PRIVATE_KEY" "$AR" \
    'storeTouch(address,(address,bytes32,uint64,uint64),bytes,address)' \
    "$u" "($c,$pid,$now,$exp)" "$sig" "$PROJECT_ADDR" || return $?

  # Confirm the attribution actually points at this promoter. Re-pin to a current
  # block first: clearing the pin entirely would let the load balancer answer from
  # a node that has not yet seen the write, which reads as the touch having failed.
  local active
  sleep 3; pin_block
  active=$(rd "$AR" 'activePromoter(address,address)(bytes32)' "$c" "$u")
  [ "$active" = "$pid" ] || die "touch stored but attribution did not stick ($active)" 3
}

cmd_report() {
  local c="$1" kpi="$2" total="$3"
  pin_block; require_campaign "$c"
  [ "$ONCHAIN_PROJECT" = "$PROJECT_ADDR" ] ||
    die "PRIVATE_KEY is not this campaign's project — reportUserAction would revert NotReporter" 3

  local u; u=$(user_addr)
  # newTotal is cumulative, not a delta. A value at or below what the user is
  # already credited is a no-op on chain, so say so rather than reporting success.
  local already; already=$(rd "$c" 'userCreditedOf(address,uint256)(uint256)' "$u" "$kpi")
  if [ -n "$already" ] && [ "$total" -le "$already" ]; then
    printf '  %-22s no-op: user already credited %s (newTotal is cumulative)\n' "report kpi$kpi" "$already"
    return 0
  fi

  send "report kpi$kpi=$total" "$PRIVATE_KEY" "$c" \
    'reportUserAction(uint256,address,uint256,bytes)' "$kpi" "$u" "$total" 0x || return $?
}

# Settlement already happens inside reportUserAction. This exists for the case the
# report landed but its settlement did not pay out — and to exercise the fact that
# settle is permissionless, so a promoter can push their own rewards through.
cmd_settle() {
  local c="$1" kpi="$2"
  pin_block; require_campaign "$c"
  send "settle kpi$kpi" "$ETHOS_PK" "$c" 'settle(address,uint256)' "$PROMOTER" "$kpi" || return $?
}

cmd_run() {
  local c="$1" kpi="$2" total="$3"
  local before after

  pin_block; require_campaign "$c"
  before=$(rd "$TOKEN" 'balanceOf(address)(uint256)' "$PROMOTER")
  printf 'promoter %s on %s\n' "$PROMOTER" "$c"

  cmd_join "$c"   || return $?
  cmd_touch "$c"  || return $?
  cmd_report "$c" "$kpi" "$total" || return $?
  cmd_settle "$c" "$kpi" || return $?

  sleep 4; pin_block
  after=$(rd "$TOKEN" 'balanceOf(address)(uint256)' "$PROMOTER")
  printf '\n  earned         %s tokens (%s -> %s)\n' \
    "$(( $(tokens "$after") - $(tokens "$before") ))" "$(tokens "$before")" "$(tokens "$after")"
  printf '  progress       %s   tiers settled %s\n' \
    "$(rd "$c" 'progressOf(address,uint256)(uint256)' "$PROMOTER" "$kpi")" \
    "$(rd "$c" 'settledTiersOf(address,uint256)(uint256)' "$PROMOTER" "$kpi")"
}

command -v cast >/dev/null || die "foundry's cast is not on PATH" 1

CMD="${1:-}"; [ $# -gt 0 ] && shift
case "$CMD" in
  -h|--help|"") usage 0 ;;
esac

ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --user) shift
      # An 0x address names an existing user directly; anything else is a seed.
      if printf '%s' "${1:-}" | grep -qiE '^0x[0-9a-f]{40}$'; then USER_ADDR="$1"; else SEED="${1:-}"; fi ;;
    --rpc) shift; RPC="${1:-}" ;;
    -h|--help) usage 0 ;;
    -*) die "unknown flag $1" 1 ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done

load_env

case "$CMD" in
  status) [ ${#ARGS[@]} -eq 1 ] || usage 1; cmd_status "${ARGS[0]}" ;;
  join)   [ ${#ARGS[@]} -eq 1 ] || usage 1; cmd_join   "${ARGS[0]}" ;;
  touch)  [ ${#ARGS[@]} -eq 1 ] || usage 1; cmd_touch  "${ARGS[0]}" ;;
  settle) [ ${#ARGS[@]} -eq 2 ] || usage 1; cmd_settle "${ARGS[0]}" "${ARGS[1]}" ;;
  report) [ ${#ARGS[@]} -eq 3 ] || usage 1; cmd_report "${ARGS[0]}" "${ARGS[1]}" "${ARGS[2]}" ;;
  run)    [ ${#ARGS[@]} -eq 3 ] || usage 1; cmd_run    "${ARGS[0]}" "${ARGS[1]}" "${ARGS[2]}" ;;
  *) die "unknown command $CMD (try --help)" 1 ;;
esac
