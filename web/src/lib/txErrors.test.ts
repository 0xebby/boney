import {describe, it, expect} from "vitest";
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  parseAbi,
  type Hex,
} from "viem";
import {describeTxError, humanizeContractError} from "./txErrors";
import {
  AttestationVerifierAbi,
  AttributionRegistryAbi,
  BoneyAbi,
  CampaignAbi,
  CampaignRegistryAbi,
  EscrowVaultAbi,
  OracleCoordinatorAbi,
  ReputationRegistryAbi,
} from "./abis";

/**
 * Error-copy tests.
 *
 * Two things are being protected. First, that no user-facing string is ever a bare custom error
 * name — that was the whole defect. Second, that the *decode* path works against real encoded
 * revert bytes, because a mapping keyed on names that never get produced is worse than useless:
 * it looks covered and shows raw hex at runtime.
 *
 * Encoded data comes from viem's own `encodeErrorResult` over the generated ABIs, so a contract
 * change that renames or re-types an error breaks these tests rather than the UI.
 */

function encode(name: string, args: readonly unknown[]): Hex {
  return encodeErrorResult({
    abi: CampaignAbi,
    errorName: name,
    args: args as never,
  } as never);
}

/** A viem error shaped the way `simulateContract` produces one for a named custom error. */
function revertError(errorName: string, args: readonly unknown[]): BaseError {
  const reverted = new ContractFunctionRevertedError({
    abi: CampaignAbi as never,
    data: encode(errorName, args),
    functionName: "activate",
  });
  const outer = new BaseError("The contract function reverted.");
  // viem walks `cause` to find the nested revert; this mirrors that chain.
  (outer as {cause?: unknown}).cause = reverted;
  return outer;
}

describe("humanizeContractError", () => {
  it("names the campaign's actual status rather than the enum index", () => {
    const {message} = humanizeContractError("WrongStatus", [3]);
    expect(message).toContain("Ended");
    expect(message).not.toContain("WrongStatus");
  });

  it("keeps the raw name and args in detail for bug reports", () => {
    const {detail} = humanizeContractError("InsufficientReputation", [
      BigInt(24_620),
      BigInt(50_000),
    ]);
    expect(detail).toBe("InsufficientReputation(24620, 50000)");
  });

  it("reports both scores exactly, so the gap is legible", () => {
    const {message} = humanizeContractError("InsufficientReputation", [
      BigInt(24_620),
      BigInt(50_000),
    ]);
    expect(message).toContain("24,620");
    expect(message).toContain("50,000");
  });

  it("presents zero-based indices one-based", () => {
    // Solidity's `TiersNotAscending(0, 1)` is the *second* tier of the *first* KPI.
    const {message} = humanizeContractError("TiersNotAscending", [BigInt(0), BigInt(1)]);
    expect(message).toContain("KPI #1");
    expect(message).toContain("tier 2");
  });

  it("distinguishes the two NotProject overloads by arity", () => {
    expect(humanizeContractError("NotProject", []).message).toContain("Switch to the wallet");
    expect(
      humanizeContractError("NotProject", [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ]).message,
    ).toContain("0x2222");
  });

  it("never prints token base units, which it has no decimals to scale", () => {
    const {message} = humanizeContractError("NotFunded", [BigInt(0), BigInt("1000000000000000000")]);
    expect(message).not.toContain("1000000000000000000");
    expect(message).toContain("Fund the campaign");
  });

  it("falls back to the error name for an unmapped error instead of swallowing it", () => {
    const {message, detail} = humanizeContractError("SomeFutureError", [BigInt(7)]);
    expect(message).toContain("SomeFutureError");
    expect(detail).toBe("SomeFutureError(7)");
  });

  it("covers every custom error the deployed ABIs can revert with", () => {
    // The guard against adding a contract error and forgetting the copy. An unmapped name still
    // renders, but it renders the name — exactly the output this module exists to eliminate.
    // Sweeps every ABI, not just Campaign: a revert can originate in any of them.
    const abis = [
      CampaignAbi,
      BoneyAbi,
      CampaignRegistryAbi,
      EscrowVaultAbi,
      AttributionRegistryAbi,
      ReputationRegistryAbi,
      AttestationVerifierAbi,
      OracleCoordinatorAbi,
    ] as readonly (readonly {type: string; name?: string}[])[];

    const names = new Set(
      abis.flatMap((abi) => abi.filter((e) => e.type === "error").map((e) => e.name as string)),
    );
    // Without a floor this assertion passes vacuously if the ABI shape ever changes and the
    // filter stops matching anything.
    expect(names.size).toBeGreaterThan(60);

    const unmapped = [...names].filter((name) =>
      humanizeContractError(name, []).message.includes(name),
    );
    expect(unmapped).toEqual([]);
  });
});

describe("describeTxError", () => {
  it("humanises a revert that viem already named", () => {
    const {message, detail} = describeTxError(revertError("AlreadyJoined", []));
    expect(message).toBe("This wallet has already joined the campaign.");
    expect(detail).toBe("AlreadyJoined()");
  });

  it("decodes a revert viem could not name, from raw bytes", () => {
    // What happens when the selector isn't in the ABI the call was simulated against — an
    // EscrowVault error surfacing from a Campaign call. viem leaves `errorName` undefined.
    const err = new BaseError("The contract function reverted.");
    (err as {cause?: unknown}).cause = {
      data: encodeErrorResult({
        abi: parseAbi(["error InsufficientBalance(uint256 available, uint256 requested)"]),
        errorName: "InsufficientBalance",
        args: [BigInt(1), BigInt(2)],
      }),
    };

    const {message} = describeTxError(err);
    expect(message).toContain("Escrow doesn't hold enough");
  });

  it("treats a wallet rejection as a plain statement, not an alarm", () => {
    const err = new BaseError("User rejected the request.");
    expect(describeTxError(err).message).toBe("You rejected the request in your wallet.");
  });

  it("explains a gas shortfall in terms of ETH, not the RPC's wording", () => {
    const err = new BaseError("insufficient funds for intrinsic transaction cost");
    expect(describeTxError(err).message).toContain("enough ETH to cover gas");
  });

  it("tells the user to switch networks on a chain mismatch", () => {
    const err = new BaseError("The current chain of the wallet does not match the target chain");
    expect(describeTxError(err).message).toContain("Switch it to the campaign's chain");
  });

  it("carries no detail for failures that never reached a contract", () => {
    expect(describeTxError(new BaseError("User rejected the request.")).detail).toBeUndefined();
  });

  it("passes through a plain Error and a non-Error throw", () => {
    expect(describeTxError(new Error("Connect a wallet first.")).message).toBe(
      "Connect a wallet first.",
    );
    expect(describeTxError("something odd").message).toBe("something odd");
  });

  it("does not throw on undecodable revert bytes", () => {
    const err = new BaseError("reverted");
    (err as {cause?: unknown}).cause = {data: "0xdeadbeef"};
    expect(() => describeTxError(err)).not.toThrow();
    expect(describeTxError(err).message).toBe("The transaction was rejected by the contract.");
  });
});
