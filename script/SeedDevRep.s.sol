// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {ReputationRegistry} from "../src/reputation/ReputationRegistry.sol";

/// @title SeedDevRep
/// @notice Registers the BoneyScore schemas and restores the dev wallet's score on a fresh registry.
/// @dev **Why this exists separately from `SeedLocal`.** `SeedLocal._seedReputation` does the same
///      work, but `SeedLocal` also deploys its own `SeedToken` and seeds four campaigns — running it
///      to recover reputation would add a rival bUSD and campaigns the fixture does not want. This
///      script touches `ReputationRegistry` only.
///
///      **Why it is needed at all.** `DeployBoney` registers no schemas, so a freshly deployed
///      `ReputationRegistry` has an empty schema set. Two things break in that state, both quietly:
///      `scoreOf` returns 0 for every wallet, and `maxScore()` returns 0 — which makes `Campaign`'s
///      constructor reject *any* non-zero `minReputation` with `UnreachableReputation`. So this must
///      run **before** `SeedDemo`, or the gated campaigns cannot be created.
///
///      **Run order after a redeploy:**
///        1. `DeployBoney`            — fresh contracts
///        2. `pnpm deployments 84532` — point the app at them
///        3. `SeedDevRep`  (this)     — schemas + dev wallet score
///        4. `SeedDemo`               — the six campaigns, three of them gated
///
///      **The values are a copy, not an invention.** They reproduce what the previous Base Sepolia
///      registry held for this wallet, read back from it before the redeploy: ETHOS_SCORE 2750,
///      X_REACH 1790, X_FOLLOWERS 30000. With weights 7/3/0 that is a BoneyScore of 24,620, which
///      `run()` asserts — a fixture that silently produced a different score would move every gate
///      in `SeedDemo` relative to the wallet meant to clear it.
///
///      `X_FOLLOWERS` carries weight 0: attested and readable for display, contributing nothing.
///      `ETHOS_SCORE` and `X_REACH` carry freshness windows so a seeded score decays like a real one,
///      and value ceilings that fix `maxScore()` at 28,000 — the ceiling `SeedDemo`'s gates sit under.
///
///      Re-runnable, with the same two replay guards `SeedLocal` documents: `registerSchema` reverts
///      `SchemaAlreadyRegistered`, so it is skipped when the schema exists; and `storeAttestation`
///      burns its `attestationId` permanently, so ids are salted with the block number. Attestations
///      overwrite the stored record, so a reseed refreshes values rather than duplicating them.
///
///      Usage (Base Sepolia):
///        PRIVATE_KEY=… REPUTATION_ADDRESS=… [SUBJECT=0x…] \
///        forge script script/SeedDevRep.s.sol:SeedDevRep --rpc-url … --broadcast --slow
contract SeedDevRep is Script {
    /// @dev Raised when the seeded score does not come out where the gates in `SeedDemo` expect it.
    error UnexpectedScore(uint256 got, uint256 want);

    /// @dev The wallet `web/.env.local`'s `ATTESTOR_PRIVATE_KEY` (== `ETHOS_PK`) signs with, and the
    ///      one `pnpm ethos:stub:dev` pins. It is unclaimed on live Ethos, which is why the stub
    ///      exists — and it is the wallet manual testing is actually done from, so it is the one
    ///      whose score has to survive a redeploy. Overridable with `SUBJECT`.
    address constant DEV_WALLET = 0x98405c5776a63547E7Cb16000bA04cA53D9Fb2f8;

    // Weights, windows and ceilings — identical to `SeedLocal`, so a wallet scored on one chain
    // scores the same on the other.
    uint256 constant ETHOS_WEIGHT = 7;
    uint256 constant REACH_WEIGHT = 3;
    uint64 constant ETHOS_MAX_AGE = 180 days;
    uint64 constant REACH_MAX_AGE = 90 days;
    uint256 constant ETHOS_MAX_VALUE = 2_800;
    uint256 constant REACH_MAX_VALUE = 2_800;

    // The dev wallet's values, read off the previous registry before it was replaced.
    uint256 constant DEV_ETHOS = 2_750;
    uint256 constant DEV_REACH = 1_790;
    uint256 constant DEV_FOLLOWERS = 30_000;

    /// @dev 7 * 2750 + 3 * 1790. Asserted rather than assumed.
    uint256 constant EXPECTED_SCORE = 24_620;

    uint256 DEPLOYER_PK;
    ReputationRegistry reputation;

    function run() external {
        DEPLOYER_PK = vm.envUint("PRIVATE_KEY");
        reputation = ReputationRegistry(vm.envAddress("REPUTATION_ADDRESS"));
        address subject = vm.envOr("SUBJECT", DEV_WALLET);

        bytes32 followers = reputation.schemaId("X_FOLLOWERS");
        bytes32 ethos = reputation.schemaId("ETHOS_SCORE");
        bytes32 reach = reputation.schemaId("X_REACH");

        (, uint256 followersWeight, bool followersExists) = reputation.schemaInfo(followers);
        (,, bool ethosExists) = reputation.schemaInfo(ethos);
        (,, bool reachExists) = reputation.schemaInfo(reach);

        vm.startBroadcast(DEPLOYER_PK);
        if (!followersExists) reputation.registerSchema("X_FOLLOWERS", 0);
        if (!ethosExists) reputation.registerSchema("ETHOS_SCORE", ETHOS_WEIGHT);
        if (!reachExists) reputation.registerSchema("X_REACH", REACH_WEIGHT);

        // Retire a legacy follower weight, exactly as `SeedLocal` does, so this script can also be
        // pointed at a chain seeded before BoneyScore existed.
        if (followersExists && followersWeight != 0) reputation.setSchemaWeight(followers, 0);

        // Freshness windows and value ceilings, set on every run: idempotent, and the ceilings must
        // land before the attestations (which `storeAttestation` bounds) and before any campaign is
        // created (whose constructor reads `maxScore`).
        if (reputation.schemaMaxAge(ethos) != ETHOS_MAX_AGE) {
            reputation.setSchemaMaxAge(ethos, ETHOS_MAX_AGE);
        }
        if (reputation.schemaMaxAge(reach) != REACH_MAX_AGE) {
            reputation.setSchemaMaxAge(reach, REACH_MAX_AGE);
        }
        if (reputation.schemaMaxValue(ethos) != ETHOS_MAX_VALUE) {
            reputation.setSchemaMaxValue(ethos, ETHOS_MAX_VALUE);
        }
        if (reputation.schemaMaxValue(reach) != REACH_MAX_VALUE) {
            reputation.setSchemaMaxValue(reach, REACH_MAX_VALUE);
        }

        _attest(subject, ethos, DEV_ETHOS, "seed-dev-ethos");
        _attest(subject, reach, DEV_REACH, "seed-dev-reach");
        _attest(subject, followers, DEV_FOLLOWERS, "seed-dev-followers");
        vm.stopBroadcast();

        uint256 score = reputation.scoreOf(subject);
        if (subject == DEV_WALLET && score != EXPECTED_SCORE) {
            revert UnexpectedScore(score, EXPECTED_SCORE);
        }

        console.log("");
        console.log("Reputation seeded for %s", subject);
        console.log("  ETHOS_SCORE (w7):  %s", DEV_ETHOS);
        console.log("  X_REACH     (w3):  %s", DEV_REACH);
        console.log("  X_FOLLOWERS (w0):  %s", DEV_FOLLOWERS);
        console.log("  BoneyScore:        %s", score);
        console.log("  maxScore (gate ceiling): %s", reputation.maxScore());
    }

    /// @dev `attestationId` is salted with the block number because `storeAttestation` burns it
    ///      permanently — a fixed string would make the second run of this script revert.
    function _attest(address subject, bytes32 schema, uint256 value, string memory tag) internal {
        reputation.storeAttestation(subject, schema, value, keccak256(abi.encode(tag, block.number)));
    }
}
