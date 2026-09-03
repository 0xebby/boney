import {describe, it, expect} from "vitest";
import {
  cardDescription,
  cardLink,
  cardPath,
  cardTitle,
  parseCardWallet,
  subjectLabel,
} from "./publicCard";
import {rankOf} from "./ranks";
import {DEFAULT_CHAIN_ID} from "./chains";

/**
 * The public card's URL rules and share copy.
 *
 * Two themes:
 *
 *  1. **A valid address always has a card.** Only a malformed path is missing. 404ing a wallet with no
 *     Ethos profile and no campaigns would tell a new promoter their card does not exist, when in fact it
 *     is the empty card the whole onboarding half was written for.
 *  2. **No number appears because a fetch failed.** Every clause of the share description is omitted
 *     rather than zeroed, because a description is the most-forwarded sentence in the system and
 *     "0 campaigns" is a claim about a person.
 */

const WALLET = "0x98405c5776a63547e7cb16000ba04ca53d9fb2f8" as const;

describe("parseCardWallet", () => {
  it("accepts an address and lowercases it", () => {
    // The value becomes a subgraph `Bytes` filter and a canonical URL. graph-node compares bytes, so a
    // checksummed address would match nothing while failing as an empty list rather than an error.
    expect(parseCardWallet("0x98405C5776A63547E7CB16000BA04CA53D9FB2F8")).toBe(WALLET);
  });

  it("accepts a mixed-case address without enforcing the checksum", () => {
    // Pasted from a block explorer. This page has no reason to reject a working address over a
    // checksum, and a 404 would be an unexplainable failure to whoever shared the link.
    expect(parseCardWallet("0x98405c5776A63547e7cb16000ba04ca53d9fb2f8")).toBe(WALLET);
  });

  it("tolerates surrounding whitespace and percent-encoding", () => {
    expect(parseCardWallet(`%20${WALLET}%20`)).toBe(WALLET);
  });

  it("rejects a handle, so no link can be minted against a re-assignable name", () => {
    // The plan's first open question, resolved against handles: an X handle can change hands, and a
    // handle URL would let a link shared today point at somebody else's card next month.
    expect(parseCardWallet("alice")).toBeUndefined();
    expect(parseCardWallet("@alice")).toBeUndefined();
  });

  it("rejects the near-misses that would otherwise reach the subgraph", () => {
    expect(parseCardWallet(undefined)).toBeUndefined();
    expect(parseCardWallet("")).toBeUndefined();
    expect(parseCardWallet("0x")).toBeUndefined();
    // One character short.
    expect(parseCardWallet("0x98405c5776a63547e7cb16000ba04ca53d9fb2f")).toBeUndefined();
    // Not hex.
    expect(parseCardWallet("0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBeUndefined();
  });

  it("accepts the zero address", () => {
    // It is a well-formed address, so it has a card: no profile, no campaigns, level 1. Rejecting it
    // would be a special case that buys nothing.
    expect(parseCardWallet(`0x${"0".repeat(40)}`)).toBe(`0x${"0".repeat(40)}`);
  });
});

describe("subjectLabel", () => {
  it("prefers the handle a reader would recognise", () => {
    expect(subjectLabel(WALLET, "alice")).toBe("@alice");
  });

  it("shortens the address when Ethos knows no handle", () => {
    // Never the bare 42 characters: a sentence with a full address in it is unreadable.
    const label = subjectLabel(WALLET, null);
    expect(label).toContain("…");
    expect(label.length).toBeLessThan(WALLET.length);
  });
});

describe("cardTitle", () => {
  it("leads with the rank, which is the part a reader can compare", () => {
    const title = cardTitle({subject: "@alice", rank: rankOf(24_620), score: 24_620});
    expect(title).toContain("@alice");
    expect(title).toContain("24,620");
    expect(title).toContain(rankOf(24_620).name);
  });

  it("falls back to the subject rather than to a zero when there is no score", () => {
    const title = cardTitle({subject: "@alice"});
    expect(title).toBe("@alice — BoneyCard");
    expect(title).not.toContain("0");
  });
});

describe("cardDescription", () => {
  it("states the counts it has", () => {
    const text = cardDescription({subject: "@alice", level: 5, campaigns: 9, tiers: 31});
    expect(text).toContain("Bone level 5");
    expect(text).toContain("9 campaigns promoted");
    expect(text).toContain("31 reward tiers crossed");
  });

  it("omits every count it does not have, rather than zeroing it", () => {
    // The unavailable-history case. A share description reading "0 campaigns, 0 tiers" because the
    // subgraph was unreachable is a claim a failed fetch has not earned.
    const text = cardDescription({subject: "@alice"});
    expect(text).not.toContain("0 campaigns");
    expect(text).not.toContain("level");
    expect(text).toContain("@alice");
  });

  it("omits a real zero too", () => {
    // A wallet that has genuinely joined nothing. True, but not worth forwarding, and indistinguishable
    // to a reader from the failure above.
    const text = cardDescription({subject: "@alice", level: 1, campaigns: 0, tiers: 0});
    expect(text).not.toContain("0 campaigns");
    expect(text).toContain("Bone level 1");
  });

  it("agrees in number", () => {
    const one = cardDescription({subject: "@alice", campaigns: 1, tiers: 1});
    expect(one).toContain("1 campaign promoted");
    expect(one).toContain("1 reward tier crossed");
  });

  it("never claims the score measures delivery", () => {
    // The BoneyScore is Ethos plus reach. A share card implying it measures delivery would be
    // advertising the one thing it does not contain.
    const text = cardDescription({subject: "@alice", level: 3, campaigns: 4, tiers: 7});
    expect(text).toContain("credibility, reach and verified delivery");
  });
});

describe("cardPath", () => {
  it("is the lowercased address, so a link and an og:url cannot disagree", () => {
    expect(cardPath("0x98405C5776A63547E7CB16000BA04CA53D9FB2F8")).toBe(`/b/${WALLET}`);
  });
});

describe("cardLink", () => {
  it("links a wallet seen on the chain the card serves", () => {
    expect(cardLink(WALLET, DEFAULT_CHAIN_ID)).toBe(`/b/${WALLET}`);
  });

  it("has no link for another chain", () => {
    // A card is per-deployment: `loadPublicCard` reads `DEFAULT_CHAIN_ID` and the path carries no chain.
    // Following a link from an anvil promoter row would answer with Base Sepolia's history, which reads
    // as a broken card rather than a link to the wrong deployment.
    expect(cardLink(WALLET, 31337)).toBeUndefined();
  });

  it("has no link when the chain is unknown", () => {
    // The server render, before wagmi has rehydrated a connection. Undefined leaves each caller showing
    // what it showed before — the explorer link, or plain text.
    expect(cardLink(WALLET, undefined)).toBeUndefined();
  });
});
