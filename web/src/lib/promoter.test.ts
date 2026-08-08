import {describe, it, expect} from "vitest";
import {
  derivePromoterId,
  hasJoined,
  canJoin,
  trackingLink,
  parseTrackingLink,
  type JoinContext,
} from "./promoter";

/**
 * Promoter guard tests.
 *
 * Same standard as `lifecycle.test.ts`: the negative cases carry the weight, because an
 * over-permissive mirror renders a button whose only feedback is a reverted transaction the
 * promoter paid gas for. Each test names the Solidity error it stands in for.
 */

const CAMPAIGN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const PROMOTER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const ZERO_ID = `0x${"00".repeat(32)}` as const;

describe("derivePromoterId", () => {
  it("is deterministic for a campaign/promoter pair", () => {
    expect(derivePromoterId(CAMPAIGN, PROMOTER)).toBe(derivePromoterId(CAMPAIGN, PROMOTER));
  });

  it("returns a 32-byte hash", () => {
    expect(derivePromoterId(CAMPAIGN, PROMOTER)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("differs per campaign, so one promoter's id is not reusable across campaigns", () => {
    const other = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
    expect(derivePromoterId(CAMPAIGN, PROMOTER)).not.toBe(derivePromoterId(other, PROMOTER));
  });

  it("differs per promoter", () => {
    const other = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
    expect(derivePromoterId(CAMPAIGN, PROMOTER)).not.toBe(derivePromoterId(CAMPAIGN, other));
  });

  it("is not symmetric — argument order is load-bearing", () => {
    // keccak256(abi.encode(campaign, promoter)), not the reverse. Swapping them would produce a
    // plausible-looking id that no touch would ever match.
    expect(derivePromoterId(CAMPAIGN, PROMOTER)).not.toBe(derivePromoterId(PROMOTER, CAMPAIGN));
  });

  it("is case-insensitive about address checksums", () => {
    // abi.encode works on the 20 raw bytes; a checksummed and a lowercase address are the same
    // address, so they must not produce different ids.
    expect(derivePromoterId(CAMPAIGN.toUpperCase().replace("0X", "0x") as `0x${string}`, PROMOTER))
      .toBe(derivePromoterId(CAMPAIGN, PROMOTER));
  });
});

describe("hasJoined", () => {
  it("treats the zero id as not joined", () => {
    expect(hasJoined(ZERO_ID)).toBe(false);
  });

  it("treats a real id as joined", () => {
    expect(hasJoined(derivePromoterId(CAMPAIGN, PROMOTER))).toBe(true);
  });

  it("handles undefined and null from a pending read", () => {
    expect(hasJoined(undefined)).toBe(false);
    expect(hasJoined(null)).toBe(false);
  });
});

describe("canJoin", () => {
  const ctx = (o: Partial<JoinContext> = {}): JoinContext => ({
    status: "Active",
    alreadyJoined: false,
    reputation: BigInt(1000),
    minReputation: BigInt(0),
    connected: true,
    ...o,
  });

  it("allows joining an active campaign", () => {
    expect(canJoin(ctx()).ok).toBe(true);
  });

  it("allows joining a PENDING campaign — promoters prepare links before launch", () => {
    // Campaign.join accepts Active *or* Pending. Restricting to Active would hide a legitimate
    // action the contract permits.
    expect(canJoin(ctx({status: "Pending"})).ok).toBe(true);
  });

  it("blocks Paused, Ended and Cancelled — Solidity: WrongStatus", () => {
    for (const status of ["Paused", "Ended", "Cancelled"] as const) {
      expect(canJoin(ctx({status})).ok, status).toBe(false);
    }
  });

  it("blocks a second join — Solidity: AlreadyJoined", () => {
    const r = canJoin(ctx({alreadyJoined: true}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already joined/i);
  });

  it("blocks below the reputation floor — Solidity: InsufficientReputation", () => {
    const r = canJoin(ctx({reputation: BigInt(999), minReputation: BigInt(1000)}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/boneyscore/i);
    // Short of the bar but non-zero: still worth offering a re-attestation, since the score may
    // simply be stale.
    expect(r.actionable).toBe("attest");
  });

  it("tells an unverified wallet to establish a score rather than quoting it a 0", () => {
    // The registry returns 0 for any wallet it holds no records for, so "your score is 0" would
    // read as a judgement when it actually means "never attested".
    const r = canJoin(ctx({reputation: BigInt(0), minReputation: BigInt(16000)}));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/verify your ethos profile/i);
    expect(r.actionable).toBe("attest");
  });

  it("does not mark status or already-joined refusals as attestable", () => {
    // No attestation makes an ended campaign joinable; offering the button would be a lie.
    expect(canJoin(ctx({status: "Ended"})).actionable).toBeUndefined();
    expect(canJoin(ctx({alreadyJoined: true})).actionable).toBeUndefined();
  });

  it("admits a score exactly at the floor — the contract uses <, not <=", () => {
    expect(canJoin(ctx({reputation: BigInt(1000), minReputation: BigInt(1000)})).ok).toBe(true);
  });

  it("ignores reputation entirely when minReputation is 0", () => {
    // The contract guards with `minReputation != 0 && score < minReputation`, so an open
    // campaign admits a zero-score wallet.
    expect(canJoin(ctx({reputation: BigInt(0), minReputation: BigInt(0)})).ok).toBe(true);
  });

  it("requires a wallet", () => {
    expect(canJoin(ctx({connected: false})).ok).toBe(false);
  });

  it("gives a reason whenever it refuses", () => {
    for (const status of ["Paused", "Ended", "Cancelled"] as const) {
      expect(canJoin(ctx({status})).reason).toBeTruthy();
    }
  });
});

describe("trackingLink", () => {
  const ID = derivePromoterId(CAMPAIGN, PROMOTER);

  it("round-trips through parseTrackingLink", () => {
    const url = trackingLink("https://boney.xyz", CAMPAIGN, ID);
    expect(parseTrackingLink(url)).toEqual({campaign: CAMPAIGN, promoterId: ID});
  });

  it("carries both fields a Touch is built from", () => {
    const url = trackingLink("https://boney.xyz", CAMPAIGN, ID);
    expect(url).toContain(CAMPAIGN);
    expect(url).toContain(ID);
  });

  it("does not bake in an expiry", () => {
    // expiresAt is set when the touch is signed, from the campaign's attributionWindow. A
    // timestamp in a shared URL would only produce a link that silently stops working.
    const url = trackingLink("https://boney.xyz", CAMPAIGN, ID);
    expect(url).not.toMatch(/expire|exp=|until/i);
  });

  it("tolerates a trailing slash on the origin", () => {
    expect(trackingLink("https://boney.xyz/", CAMPAIGN, ID)).toBe(
      trackingLink("https://boney.xyz", CAMPAIGN, ID),
    );
  });

  it("rejects a malformed campaign address", () => {
    expect(parseTrackingLink(`https://boney.xyz/r?c=0xnope&p=${ID}`)).toBeNull();
  });

  it("rejects a promoter id of the wrong width", () => {
    expect(parseTrackingLink(`https://boney.xyz/r?c=${CAMPAIGN}&p=0x1234`)).toBeNull();
  });

  it("rejects a link missing a parameter, and a non-URL", () => {
    expect(parseTrackingLink(`https://boney.xyz/r?c=${CAMPAIGN}`)).toBeNull();
    expect(parseTrackingLink("not a url")).toBeNull();
  });
});
