import {describe, it, expect} from "vitest";
import {parseAbiItem, toEventSelector} from "viem";
import {PROMOTER_JOINED, TOUCH_STORED} from "./events";

/**
 * These assert equivalence against the exact signature strings the two hooks used to carry inline.
 *
 * The point is not that `find` works. It is that switching from a hand-written declaration to an
 * ABI-derived one did not change a single topic0 — if it had, `getLogs` would silently match nothing
 * and the promoter directory and touch list would render empty rather than erroring.
 */
describe("protocol event declarations", () => {
  /** The three fields that decide how a log decodes; everything else is annotation. */
  const shape = (inputs: readonly {name?: string; type: string; indexed?: boolean}[]) =>
    inputs.map((i) => ({name: i.name, type: i.type, indexed: i.indexed === true}));

  const cases = [
    {
      name: "PromoterJoined",
      derived: PROMOTER_JOINED,
      previous:
        "event PromoterJoined(address indexed promoter, bytes32 indexed promoterId, uint256 reputation)",
    },
    {
      name: "TouchStored",
      derived: TOUCH_STORED,
      previous:
        "event TouchStored(address indexed campaign, address indexed user, bytes32 indexed promoterId, uint64 signedAt, uint64 expiresAt, address relayer)",
    },
  ] as const;

  for (const {name, derived, previous} of cases) {
    it(`${name} matches the signature it replaced, topic0 included`, () => {
      const hand = parseAbiItem(previous);
      expect(derived.name).toBe(name);
      expect(derived.type).toBe("event");
      // topic0 is what getLogs actually filters on, so equality here is the property that matters.
      expect(toEventSelector(derived)).toBe(toEventSelector(hand));
      // And the decoded shape, so `log.args.<field>` reads keep working. Compared field by field
      // rather than deep-equal: solc annotates each param with `internalType` and states `indexed`
      // explicitly, neither of which `parseAbiItem` emits. Both are inert for decoding.
      expect(shape(derived.inputs)).toEqual(shape(hand.inputs));
    });
  }

  it("keeps every indexed arg the hooks filter or read by name", () => {
    // `useCampaignTouches` filters on `args: {campaign}`; the rest are read off each log.
    const indexed = TOUCH_STORED.inputs.filter((i) => i.indexed).map((i) => i.name);
    expect(indexed).toEqual(["campaign", "user", "promoterId"]);
  });
});
