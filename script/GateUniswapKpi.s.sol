// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Campaign} from "../src/campaign/Campaign.sol";
import {EventMetricKpiVerifier} from "../src/verifiers/EventMetricKpiVerifier.sol";
import {GuardedKpiVerifier} from "../src/verifiers/GuardedKpiVerifier.sol";
import {IEventMetricKpiVerifier} from "../src/interfaces/IEventMetricKpiVerifier.sol";
import {IGuardedKpiVerifier} from "../src/interfaces/IGuardedKpiVerifier.sol";

/// @title GateUniswapKpi
/// @notice Repairs the one gated KPI `SeedFive` created but never configured.
/// @dev `_uniswap` set `verifier` to `GuardedKpiVerifier` without calling `_gate`, so the KPI pointed at
///      a guard that had no config for it. That fails closed rather than open — `GuardedKpiVerifier`
///      reverts on an unconfigured KPI and the relayer refused to run with "KPI 0 … is not configured"
///      — so nothing was mis-credited, but the KPI could not move either.
///
///      Configuration is post-hoc by design: `setKpiConfig` and `setGuardConfig` are owner-only and
///      idempotent, and `KpiSpec.verifier` is the only part fixed at creation. So this is a repair
///      rather than a reseed. `SeedFive` now calls `_gate` here too, for the next fresh run.
contract GateUniswapKpi is Script {
    address public constant UNI_POOL = 0x46880b404CD35c165EDdefF7421019F8dD25F4Ad;
    string public constant UNI_SWAP_EVENT =
        "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";

    uint256 public constant BLOCK_TIME = 2;
    uint256 public constant BLOCK_MARGIN = 10_000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address campaign = vm.envAddress("CAMPAIGN");
        uint256 windowStartBlock = vm.envUint("WINDOW_START_BLOCK");

        EventMetricKpiVerifier kpiVerifier =
            EventMetricKpiVerifier(vm.envAddress("KPI_VERIFIER_ADDRESS"));
        GuardedKpiVerifier guardedVerifier =
            GuardedKpiVerifier(vm.envAddress("GUARDED_VERIFIER_ADDRESS"));

        Campaign c = Campaign(campaign);
        uint256 closesIn = uint256(c.endTime() - c.startTime()) + c.CLAIM_GRACE();
        uint256 windowEndBlock = block.number + closesIn / BLOCK_TIME + BLOCK_MARGIN;

        vm.startBroadcast(pk);
        kpiVerifier.setKpiConfig(
            campaign,
            0,
            UNI_POOL,
            UNI_SWAP_EVENT,
            1, // recipient, in declaration order
            IEventMetricKpiVerifier.Aggregation.COUNT,
            0,
            1,
            windowStartBlock,
            windowEndBlock
        );
        guardedVerifier.setGuardConfig(campaign, 0, address(0), 0, IGuardedKpiVerifier.Mode.AGREE);
        vm.stopBroadcast();

        console.log("Configured Uniswap kpi 0");
        console.log("  campaign        ", campaign);
        console.log("  windowStartBlock", windowStartBlock);
        console.log("  windowEndBlock  ", windowEndBlock);
    }
}
