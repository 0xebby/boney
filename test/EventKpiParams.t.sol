// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {SeedEventKpi} from "../script/SeedEventKpi.s.sol";

/// @title EventKpiParamsTest
/// @notice Pins the `KpiSpec.params` encoding shared by Solidity and the TypeScript indexer.
/// @dev The frontend encodes this blob (`web/src/lib/kpiSource.ts`) and the indexer decodes it
///      (`web/src/lib/indexerCore.ts`), while seed scripts write it from Solidity. Nothing on chain
///      validates it — `Campaign` forwards `params` to the verifier and otherwise ignores it — so
///      the two sides disagreeing produces a campaign that deploys cleanly and then indexes
///      nothing, silently, forever.
///
///      The expected value below was produced by the TypeScript encoder and confirmed identical to
///      `cast abi-encode`. If a field is reordered or retyped on either side, this fails.
contract EventKpiParamsTest is Test {
    /// @dev Exactly what `encodeEventSource` emits for the WETH deposit preset.
    bytes constant EXPECTED = hex"0000000000000000000000004200000000000000000000000000000000000006"
        hex"e1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c"
        hex"0000000000000000000000000000000000000000000000000000000000000001"
        hex"0000000000000000000000000000000000000000000000000000000000000001"
        hex"00000000000000000000000000000000000000000000000000038d7ea4c68000";

    function test_paramsMatchTypescriptEncoder() public pure {
        bytes memory encoded = abi.encode(
            0x4200000000000000000000000000000000000006,
            0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c,
            uint8(1),
            uint8(1),
            uint256(1e15)
        );

        assertEq(encoded, EXPECTED, "params encoding drifted from the TypeScript encoder");
    }

    /// @dev The script's constants are the same values, so they must produce the same bytes.
    function test_scriptConstantsProduceTheSameBlob() public {
        SeedEventKpi script = new SeedEventKpi();

        bytes memory encoded = abi.encode(
            script.WETH(),
            script.DEPOSIT_TOPIC(),
            script.ACTOR_TOPIC(),
            script.AMOUNT_MODE_DATA_WORD0(),
            script.SCALE()
        );

        assertEq(encoded, EXPECTED, "SeedEventKpi constants drifted");
    }

    /// @dev `topic0` is the keccak of the exact signature string; a stray space would change it.
    function test_depositTopicIsTheKeccakOfTheSignature() public pure {
        assertEq(
            keccak256("Deposit(address,uint256)"),
            0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c
        );
    }

    /// @dev A 160-byte blob is not 32, so `TouchWindowVerifier._lookback` returns 0 — strict, and
    ///      therefore fail-safe, but never the lookback anyone configured. The two encodings cannot
    ///      share the field; this records why.
    function test_eventBlobIsNotAValidLookback() public pure {
        assertEq(EXPECTED.length, 160);
        assertTrue(EXPECTED.length != 32);
    }
}
