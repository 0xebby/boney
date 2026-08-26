import {describe, it, expect, vi} from "vitest";
import {
  classifyGraphBody,
  decodeMeta,
  graphLag,
  hexLower,
  paginate,
  toBigInt,
  GRAPH_MAX_PAGES,
  GRAPH_PAGE_SIZE,
  type GraphResult,
} from "./graph";

/**
 * Subgraph transport tests.
 *
 * One theme runs through all of them: **a failed read may never look like an empty one.** Every count
 * the BoneyCard derives from this data is a statement about a person, so "0 campaigns" has to be
 * unreachable from any failure path. The cases below are the paths that could produce it — a 200
 * carrying `errors`, a partial response, an unparseable body, an exhausted paginator — plus the one
 * case that legitimately *is* empty and must not be reported as broken.
 *
 * The second theme is decode: The Graph serialises `BigInt` as a JSON string, and `Bytes` filters are
 * compared byte-wise, so a checksummed address matches nothing and fails **silently**.
 */

describe("classifyGraphBody", () => {
  const pick = (data: Record<string, unknown>) =>
    Array.isArray(data.promoters) ? (data.promoters as unknown[]) : undefined;

  it("reads an ordinary success", () => {
    const result = classifyGraphBody(200, {data: {promoters: [{id: "a"}]}}, pick);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data).toHaveLength(1);
  });

  it("treats an empty collection as an answer, not a failure", () => {
    // The ordinary state for a wallet that has joined nothing. Reporting it as unavailable would put
    // "history unavailable" on every new promoter's card, which is the state the card most needs to
    // get right.
    const result = classifyGraphBody(200, {data: {promoters: []}}, pick);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data).toEqual([]);
  });

  it("fails a 200 that carries errors", () => {
    const result = classifyGraphBody(
      200,
      {errors: [{message: "Store error: bad entity"}]},
      pick,
    );
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toBe("graphql");
    expect(result.message).toMatch(/Store error/);
  });

  it("fails a partial response even though `data` is populated", () => {
    // graph-node returns a filled `data` alongside a field-level error. Folding that into counts
    // yields figures that are quietly too low — worse than saying nothing, because it looks right.
    const result = classifyGraphBody(
      200,
      {data: {promoters: [{id: "a"}]}, errors: [{message: "field failed"}]},
      pick,
    );
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toBe("graphql");
  });

  it("distinguishes a schema drift from an empty result", () => {
    // `promoters` absent entirely: the deployment does not have the shape this build asks for. That is
    // not the same as a wallet with no memberships, and must not read as one.
    const result = classifyGraphBody(200, {data: {somethingElse: []}}, pick);
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toBe("malformed");
  });

  it("reports an unreadable 200 body as malformed, not as empty", () => {
    expect(classifyGraphBody(200, null, pick)).toMatchObject({reason: "malformed"});
    expect(classifyGraphBody(200, {data: null}, pick)).toMatchObject({reason: "malformed"});
  });

  it("names rate limiting, because it is the one HTTP failure that resolves itself", () => {
    const result = classifyGraphBody(429, {}, pick);
    expect(result).toMatchObject({kind: "unavailable", reason: "http"});
    if (result.kind !== "unavailable") return;
    expect(result.message).toMatch(/rate-limiting/);
  });

  it("reports other non-2xx with the status", () => {
    const result = classifyGraphBody(502, "<html>bad gateway</html>", pick);
    expect(result).toMatchObject({kind: "unavailable", reason: "http"});
    if (result.kind !== "unavailable") return;
    expect(result.message).toMatch(/502/);
  });
});

describe("toBigInt", () => {
  it("parses the JSON strings The Graph actually sends", () => {
    // BigInt is serialised as a string precisely because these exceed MAX_SAFE_INTEGER. A decoder
    // that used Number() would round an 18-decimal token amount and never say so.
    expect(toBigInt("1000000000000000000")).toBe(BigInt("1000000000000000000"));
    expect(toBigInt("  42  ")).toBe(BigInt(42));
  });

  it("accepts the number form Int fields use", () => {
    expect(toBigInt(1234)).toBe(BigInt(1234));
    expect(toBigInt(1.9)).toBe(BigInt(1));
  });

  it("survives every absent or unparseable shape", () => {
    for (const raw of [undefined, null, "", "  ", "not a number", {}, [], NaN, Infinity]) {
      expect(toBigInt(raw), String(raw)).toBe(BigInt(0));
    }
  });
});

describe("hexLower", () => {
  it("lowercases a checksummed address", () => {
    // The silent-failure guard. graph-node compares Bytes byte-wise, so a checksummed address in a
    // `where` returns an empty list — no error — and the card reads "0 campaigns" for a promoter with
    // twenty. wagmi hands out checksummed addresses, so this is not hypothetical.
    expect(hexLower("0x2755A4A19B9B4D3b1e9Bd1cDe3b5DB2a0f9adcc2")).toBe(
      "0x2755a4a19b9b4d3b1e9bd1cde3b5db2a0f9adcc2",
    );
  });
});

describe("decodeMeta", () => {
  it("reads the indexed block and the error flag", () => {
    expect(decodeMeta({block: {number: 45856660}, hasIndexingErrors: false})).toEqual({
      indexedBlock: BigInt(45856660),
      hasIndexingErrors: false,
    });
  });

  it("defaults a missing _meta rather than throwing", () => {
    // `_meta` rides along in a document whose other fields already succeeded, so its absence must not
    // take the whole read down — the footer simply has no lag to show.
    expect(decodeMeta(null)).toEqual({indexedBlock: BigInt(0), hasIndexingErrors: false});
    expect(decodeMeta({})).toEqual({indexedBlock: BigInt(0), hasIndexingErrors: false});
  });

  it("treats a missing hasIndexingErrors as false, never as true", () => {
    // The flag drives a warning. Defaulting it on would warn about every healthy deployment.
    expect(decodeMeta({block: {number: 1}}).hasIndexingErrors).toBe(false);
  });
});

describe("graphLag", () => {
  it("reports how far behind the indexer is", () => {
    expect(graphLag(BigInt(100), BigInt(140))).toBe(BigInt(40));
  });

  it("clamps a healthy indexer at zero rather than reporting a negative lag", () => {
    // `_meta` and the RPC head come from different sources, and on 2-second Base blocks a current
    // indexer routinely reads ahead of a cached eth_blockNumber.
    expect(graphLag(BigInt(141), BigInt(140))).toBe(BigInt(0));
  });

  it("has no answer without a chain head", () => {
    expect(graphLag(BigInt(100), undefined)).toBeUndefined();
  });
});

describe("paginate", () => {
  const rows = (from: number, count: number) =>
    Array.from({length: count}, (_, i) => ({id: `id-${String(from + i).padStart(6, "0")}`}));

  const ok = <T,>(data: T): GraphResult<T> => ({kind: "ok", data});

  it("makes no request at all when the seed page is short", async () => {
    // The realistic case for every promoter: memberships and payouts arrive with round trip 1 and the
    // walk is already over. A paginator that always fetched would double the requests for nothing.
    const fetchPage = vi.fn();
    const result = await paginate(fetchPage, rows(0, 3));

    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data.rows).toHaveLength(3);
    expect(result.data.truncated).toBe(false);
  });

  it("continues past a full seed page and advances the cursor by last id", async () => {
    const seen: string[] = [];
    const result = await paginate(async (cursor) => {
      seen.push(cursor);
      return ok(rows(GRAPH_PAGE_SIZE, 2));
    }, rows(0, GRAPH_PAGE_SIZE));

    expect(seen).toEqual([`id-${String(GRAPH_PAGE_SIZE - 1).padStart(6, "0")}`]);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data.rows).toHaveLength(GRAPH_PAGE_SIZE + 2);
    expect(result.data.truncated).toBe(false);
  });

  it("starts from an empty cursor with no seed", async () => {
    const seen: string[] = [];
    await paginate(async (cursor) => {
      seen.push(cursor);
      return ok(rows(0, 1));
    });
    expect(seen).toEqual([""]);
  });

  it("flags truncation instead of walking forever, and keeps what it read", async () => {
    // A cap, not a loop: this runs in a browser against a shared endpoint. Hitting it makes every
    // derived count a floor, which the card has to say — silently truncating would present a partial
    // history as a total.
    let calls = 0;
    const result = await paginate(async () => {
      calls += 1;
      return ok(rows(calls * GRAPH_PAGE_SIZE, GRAPH_PAGE_SIZE));
    });

    expect(calls).toBe(GRAPH_MAX_PAGES);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data.truncated).toBe(true);
    expect(result.data.rows).toHaveLength(GRAPH_MAX_PAGES * GRAPH_PAGE_SIZE);
  });

  it("counts the seed against the page budget", async () => {
    let calls = 0;
    await paginate(async () => {
      calls += 1;
      return ok(rows(calls * GRAPH_PAGE_SIZE, GRAPH_PAGE_SIZE));
    }, rows(0, GRAPH_PAGE_SIZE));

    expect(calls).toBe(GRAPH_MAX_PAGES - 1);
  });

  it("propagates a mid-walk failure rather than returning the partial rows", async () => {
    // The most dangerous case in this file. Pages 1..n-1 succeeded, so there ARE rows in hand — and
    // returning them would hand the card a confident, wrong, lower number. The failure has to win.
    const result = await paginate(
      async () => ({kind: "unavailable", reason: "http", message: "boom"}),
      rows(0, GRAPH_PAGE_SIZE),
    );

    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toBe("http");
  });

  it("stops rather than re-reading a page when a row has no id to cursor from", async () => {
    // Defensive: an id-less full page would otherwise make the same request forever.
    const fetchPage = vi.fn();
    const seed = rows(0, GRAPH_PAGE_SIZE);
    seed[seed.length - 1] = {id: ""};

    const result = await paginate(fetchPage, seed);

    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.data.truncated).toBe(true);
  });
});
