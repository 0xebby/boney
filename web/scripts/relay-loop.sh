#!/usr/bin/env bash
# Runs `pnpm relay` over every gated KPI on a cycle.
#
# Usage: RPC=<url> ./scripts/relay-loop.sh [--once] [interval_seconds]
# `--once` completes one pass before exiting.
set -u
ONCE=0
if [ "${1:-}" = "--once" ]; then ONCE=1; shift; fi
RPC="${RPC:-https://base-sepolia-rpc.publicnode.com}"
INTERVAL="${1:-120}"

# campaign:kpiIndex.
#
# Only the **gated** KPIs belong here. Relaying an ungated one is pointless: with `verifier == 0x0` the
# campaign credits the reported figure as-is, so there is no ceiling to raise. The empty-list branch
# below stays for a fixture reseed, where a stale address must be removed before the new one exists.
#
# Addresses change with every `DeployBoney` + reseed, and a stale one is silent: the relayer reports
# against a dead campaign, credits nothing, and the gated KPI simply stays flat.
#
# A KPI that watches the escrow token is normally kept *out* of this list. Its `Transfer` events
# include things that are not user actions — the referral's own self-transfers, tier payouts leaving
# the EscrowVault, the Boney facade moving tokens — and the payout case is self-reinforcing, since a
# payout raises the observed ceiling, which unlocks the next tier, which pays out again. The
# 2026-09-18 fixture below is the exception: `SeedDemo` escrows bUSD and points every KPI at bUSD
# `Transfer`, so the three targets watch their own payout token.
TARGETS=(
  # Creed Test, seeded 2026-09-18: bUSD received.
  0x1c77040cF14d575dAC689ADc127bc009F78D2658:0
  # Zero Labs, seeded 2026-09-18: bUSD received, two KPIs.
  0x920e1B05A3BC1ee81360DB2eBf3032a2a63CeACF:0
  0x920e1B05A3BC1ee81360DB2eBf3032a2a63CeACF:1
)

if [ "${#TARGETS[@]}" -eq 0 ]; then
  printf '[%s] no gated KPIs to relay — none are listed in TARGETS.\n' "$(date -u +%H:%M:%S)"
  exit 0
fi

# Preserve live relay output and retain it for pass classification.
PASS_LOG="$(mktemp -t boney-relay-pass.XXXXXX)"
trap 'rm -f "$PASS_LOG"' EXIT

while true; do
  for t in "${TARGETS[@]}"; do
    c="${t%%:*}"; k="${t##*:}"
    printf '[%s] %s kpi %s scanning…\n' "$(date -u +%H:%M:%S)" "${c:0:10}" "$k"
    pnpm relay --campaign "$c" --kpi "$k" --rpc "$RPC" 2>&1 | tee "$PASS_LOG"
    out=$(cat "$PASS_LOG")
    # Credit lines contain an address followed by `old → new`; scan-range lines do not.
    credited=$(printf '%s' "$out" | command grep -E '0x[0-9a-fA-F]{40}: [0-9]+ → [0-9]+')
    if [ -n "$credited" ]; then
      printf '[%s] %s kpi %s CREDITED: %s\n' "$(date -u +%H:%M:%S)" "${c:0:10}" "$k" \
        "$(printf '%s' "$credited" | tr -s ' \n' ' ')"
    elif printf '%s' "$out" | command grep -qE "done — checkpoint now at"; then
      : # checkpoint advanced, nothing creditable — the quiet common case
    elif printf '%s' "$out" | command grep -qE "nothing new to scan"; then
      :
    else
      printf '[%s] %s kpi %s PROBLEM: %s\n' "$(date -u +%H:%M:%S)" "${c:0:10}" "$k" \
        "$(printf '%s' "$out" | tail -3 | tr -s ' \n' ' ')"
    fi
  done
  [ "$ONCE" = 1 ] && break
  sleep "$INTERVAL"
done
