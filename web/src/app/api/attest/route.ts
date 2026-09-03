import {createPublicClient, http, keccak256, toBytes, stringToHex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import type {NextRequest} from "next/server";
import {buildScoreReport, EthosError, isAddress} from "@/lib/ethos";
import {SCHEMA_ETHOS, SCHEMA_REACH, SCHEMA_FOLLOWERS} from "@/lib/boneyscore";
import {AttestationVerifierAbi} from "@/lib/abis";
import {getDeployment, ZERO_ADDRESS} from "@/lib/chains";
import {chainFor, rpcFor} from "@/lib/serverChain";

/**
 * Attestor endpoint — turns an Ethos profile into signed reputation attestations.
 *
 * The chain cannot make HTTP calls, so BoneyScore's inputs arrive by attestation: this route reads
 * Ethos, computes the normalised reach, and signs one EIP-712 `Attestation` per schema. It never
 * sends a transaction. The promoter's own wallet submits the bundle to
 * `ReputationRegistry.submitAttestation`, which is permissionless precisely so that authority
 * comes from the signature rather than the caller — the signing key stays server-side and the user
 * pays their own gas.
 *
 * Three values are signed per request:
 *   ETHOS_SCORE  (weight 7) — raw Ethos score
 *   REACH      (weight 3) — log-normalised follower count
 *   FOLLOWERS  (weight 0) — raw count, stored for display only
 *
 * Security posture: `ATTESTOR_PRIVATE_KEY` can mint arbitrary reputation, so the route fails
 * closed when it is unset and never echoes it. The signed payload binds the subject, so a
 * signature fetched for one wallet cannot be replayed for another; the verifier additionally
 * consumes a per-attestor nonce and the registry rejects a repeated attestation id.
 */

/** Node runtime: viem's signing path needs Node crypto, not the edge runtime. */
export const runtime = "nodejs";
/** Every response depends on live upstream data and a live nonce. Never cache. */
export const dynamic = "force-dynamic";

/** Attestations must be submitted promptly; the verifier rejects an expired payload. */
const TTL_SECONDS = 15 * 60;

const ATTESTATION_TYPES = {
  Attestation: [
    {name: "attestor", type: "address"},
    {name: "subject", type: "address"},
    {name: "schemaId", type: "bytes32"},
    {name: "value", type: "uint256"},
    {name: "nonce", type: "uint256"},
    {name: "expiresAt", type: "uint64"},
    {name: "data", type: "bytes32"},
  ],
} as const;

/**
 * Serialises signing so two in-flight requests cannot interleave their nonce reads.
 *
 * This bounds the damage but does not eliminate the race, and it is worth being precise about
 * why. The verifier's nonce advances when an attestation is *submitted*, not when it is signed —
 * and submission happens later, from the promoter's wallet. So two promoters who both request before
 * either submits will be handed the same starting nonce, and whichever submits second reverts
 * with `InvalidNonce` and has to request again.
 *
 * Pre-allocating nonces per request would be worse, not better: the verifier requires a strictly
 * sequential nonce, so a batch that is signed and then abandoned leaves a permanent gap that
 * blocks every later attestation until something consumes it. Re-reading the chain each time and
 * letting the loser retry is the failure mode that self-heals.
 */
let signingChain: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = signingChain.then(work, work);
  // Keep the chain alive regardless of individual failures.
  signingChain = result.catch(() => undefined);
  return result;
}

const schemaIdOf = (name: string) => keccak256(stringToHex(name));

function fail(code: string, message: string, status: number) {
  return Response.json({error: code, message}, {status});
}

export async function POST(request: NextRequest) {
  const key = process.env.ATTESTOR_PRIVATE_KEY;
  if (!key) {
    // Fail closed: without a key there is nothing to sign, and guessing would be worse.
    return fail("attestor_unconfigured", "The attestor is not configured on this deployment.", 500);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("bad_request", "Expected a JSON body.", 400);
  }

  const wallet = (body as {wallet?: unknown})?.wallet;
  if (!isAddress(wallet)) {
    return fail("invalid_address", "Provide a wallet address as `wallet`.", 400);
  }

  const chainId = Number((body as {chainId?: unknown})?.chainId ?? 31337);
  const deployment = getDeployment(chainId);
  const chain = chainFor(chainId);
  if (!deployment || !chain || deployment.attestationVerifier === ZERO_ADDRESS) {
    return fail("unknown_chain", `No Boney deployment for chain ${chainId}.`, 400);
  }

  const account = privateKeyToAccount(key as `0x${string}`);
  // `rpcFor` rather than a bare `http()`: viem's default for Base Sepolia is `sepolia.base.org`, which
  // 502s roughly one call in three, and a flaked nonce read mints a signature against a stale nonce.
  const client = createPublicClient({chain, transport: http(rpcFor(chain.id))});

  /**
   * Refuse before signing if this key is not a registered attestor on the target chain.
   *
   * Without this the route happily signs, `submitAttestation` reverts `NotAnAttestor`, and the promoter
   * discovers it from a failed transaction — having paid gas to learn that the *server* is
   * misconfigured. The revert names the attestor address and nothing else, so the actual cause (this
   * deployment is holding the wrong key for the chain it is pointed at) has to be worked out by hand.
   *
   * It is a real configuration hazard rather than a hypothetical: `ATTESTOR_PRIVATE_KEY` names the
   * *referral* wallet in the repo-root `.env`, and the *attestor* in
   * `web/.env.local`. Any process that picks up the first while serving this route signs with a key the
   * verifier has never heard of, and every attestation it mints is unusable.
   *
   * An outage on this read fails closed. A signature that cannot be checked is worth less than an
   * error: the alternative is minting one that consumes a nonce and then reverts, and the monotonic
   * nonce means that gap blocks every later attestation from this attestor.
   */
  try {
    const registered = (await client.readContract({
      address: deployment.attestationVerifier,
      abi: AttestationVerifierAbi,
      functionName: "isAttestor",
      args: [account.address],
    })) as boolean;

    if (!registered) {
      return fail(
        "attestor_unregistered",
        `The signing key on this deployment (${account.address}) is not a registered attestor on ` +
          `${chain.name}. Point ATTESTOR_PRIVATE_KEY at a registered attestor, or register this one.`,
        500,
      );
    }
  } catch {
    return fail(
      "attestor_uncheckable",
      `Could not confirm the attestor is registered on ${chain.name}. Refusing to sign rather than ` +
        "mint an attestation that would consume a nonce and revert.",
      502,
    );
  }

  // Gather the off-chain facts before taking the signing lock, so a slow upstream does not block
  // other callers' nonces.
  let report;
  try {
    report = await buildScoreReport(wallet);
  } catch (error) {
    if (error instanceof EthosError) return fail(error.code, error.message, error.httpStatus);
    return fail("ethos_unavailable", "Could not build a score for this wallet.", 502);
  }

  const values: Array<{schema: string; value: number}> = [
    {schema: SCHEMA_ETHOS, value: report.ethos},
    {schema: SCHEMA_REACH, value: report.reach},
    {schema: SCHEMA_FOLLOWERS, value: report.followers},
  ];

  try {
    const signed = await serialize(async () => {
      // Re-read every time rather than caching: the nonce moves when a *user* submits, which this
      // process never observes. A stale cached value would mint permanently unusable signatures.
      const startNonce = (await client.readContract({
        address: deployment.attestationVerifier,
        abi: AttestationVerifierAbi,
        functionName: "nonces",
        args: [account.address],
      })) as bigint;

      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + TTL_SECONDS);
      // Binds the attestation to the upstream data it came from, as off-chain evidence.
      const evidence = keccak256(
        toBytes(JSON.stringify({ethos: report.ethos, followers: report.followers, handle: report.handle})),
      );

      const domain = {
        name: "Boney Attestations",
        version: "1",
        chainId,
        verifyingContract: deployment.attestationVerifier,
      } as const;

      return Promise.all(
        values.map(async ({schema, value}, i) => {
          const attestation = {
            attestor: account.address,
            subject: report.wallet,
            schemaId: schemaIdOf(schema),
            value: BigInt(value),
            // One nonce per signature, in submission order.
            nonce: startNonce + BigInt(i),
            expiresAt,
            data: evidence,
          };

          const signature = await account.signTypedData({
            domain,
            types: ATTESTATION_TYPES,
            primaryType: "Attestation",
            message: attestation,
          });

          return {
            schema,
            // Stringify the bigints: JSON cannot carry them, and the client rebuilds them.
            attestation: {
              ...attestation,
              value: attestation.value.toString(),
              nonce: attestation.nonce.toString(),
              expiresAt: attestation.expiresAt.toString(),
            },
            signature,
          };
        }),
      );
    });

    return Response.json({
      wallet: report.wallet,
      ethos: report.ethos,
      followers: report.followers,
      smartFollowers: report.smartFollowers,
      reach: report.reach,
      handle: report.handle,
      attestor: account.address,
      // Order matters: nonces are sequential, so submit in the order returned.
      signed,
    });
  } catch (error) {
    return fail("signing_failed", `Could not sign attestations: ${(error as Error).message}`, 502);
  }
}
