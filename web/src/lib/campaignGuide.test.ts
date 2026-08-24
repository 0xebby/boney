import {describe, it, expect} from "vitest";
import {
  MAX_ACTION_LENGTH,
  MAX_SUMMARY_LENGTH,
  canonicalGuideMessage,
  catalogGuide,
  emptyGuideDraft,
  guideDraftFrom,
  guideForKpi,
  guideFromDraft,
  isEmptyGuide,
  linkLabel,
  resolveCampaignGuide,
  safeExternalUrl,
  sanitizeGuide,
  validateGuideDraft,
  type GuideDraft,
} from "./campaignGuide";

/** The live Base Sepolia fixture's Aave campaign — `CampaignRegistry.campaignAt(1)`. */
const AAVE = "0x014e8499Da2F401F9F0FC4785952c141b1eA6be4";
const UNSEEDED = "0x1111111111111111111111111111111111111111";
const BASE_SEPOLIA = 84532;

describe("safeExternalUrl", () => {
  /*
    An allowlist of one scheme, so the table below is the whole contract. Every rejected row is a
    string that would otherwise render as an anchor on a page telling a referral they are attributed
    to a promoter — which is exactly the moment they are most likely to click it.
  */
  it("accepts https and nothing else", () => {
    expect(safeExternalUrl("https://app.example.com/mint")).toBe("https://app.example.com/mint");
    expect(safeExternalUrl("  https://example.com  ")).toBe("https://example.com/");

    for (const rejected of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "blob:https://example.com/abc",
      // A downgrade a reader cannot see from an https page.
      "http://example.com",
      // Relative, so it would resolve against Boney's own origin.
      "/campaign/1",
      "example.com",
      "",
      "   ",
    ]) {
      expect(safeExternalUrl(rejected), rejected).toBeUndefined();
    }
  });

  /*
    `https://evil.com@app.aave.com/` navigates to evil.com while `linkLabel` would print app.aave.com.
    Refused outright rather than stripped, since the only reason to write one is to be misread.
  */
  it("refuses credentials in the authority", () => {
    expect(safeExternalUrl("https://evil.example@app.example.com/")).toBeUndefined();
    expect(safeExternalUrl("https://user:pass@example.com/")).toBeUndefined();
  });

  it("ignores anything that is not a string", () => {
    expect(safeExternalUrl(undefined)).toBeUndefined();
    expect(safeExternalUrl(null)).toBeUndefined();
    expect(safeExternalUrl(42)).toBeUndefined();
    expect(safeExternalUrl({href: "https://example.com"})).toBeUndefined();
  });
});

describe("linkLabel", () => {
  it("names the host a link goes to, without www", () => {
    expect(linkLabel("https://www.example.com/a/b?c=d")).toBe("example.com");
    expect(linkLabel("https://app.example.com")).toBe("app.example.com");
  });

  it("falls back to the raw string rather than throwing", () => {
    expect(linkLabel("not a url")).toBe("not a url");
  });
});

describe("catalogGuide", () => {
  it("is chain-scoped and case-insensitive on the address", () => {
    expect(catalogGuide(BASE_SEPOLIA, AAVE)?.summary).toContain("Aave V3");
    expect(catalogGuide(BASE_SEPOLIA, AAVE.toLowerCase())?.summary).toContain("Aave V3");
    // The same address on another chain holds different code, so it inherits nothing.
    expect(catalogGuide(11155111, AAVE)).toBeUndefined();
    expect(catalogGuide(undefined, AAVE)).toBeUndefined();
    expect(catalogGuide(BASE_SEPOLIA, undefined)).toBeUndefined();
    expect(catalogGuide(BASE_SEPOLIA, UNSEEDED)).toBeUndefined();
  });

  /*
    The reason this file exists rather than a `url` per entry: a wrong outbound link is worse than a
    wrong label. Aave's and Uniswap's testnet interfaces were never verified from this repo the way
    their contract addresses were, so the catalog carries prose and lets the explorer link stand.
  */
  it("carries no URLs at all", () => {
    for (const address of [
      "0x938E0c2Ef6E3ED250D1D004050091f0A26076fEC",
      AAVE,
      "0x6dC20396480557E001ea986BD765D81A7279DeD5",
      "0x5C42acDAff94B3d15D48Ebf76c9a48e3A55888a3",
      "0xaBC517769c86a2122bCe19422b7863296c8BCF90",
    ]) {
      const guide = catalogGuide(BASE_SEPOLIA, address);
      expect(guide, address).toBeDefined();
      expect(guide?.siteUrl, address).toBeUndefined();
      for (const kpi of guide?.kpis ?? []) expect(kpi.url, address).toBeUndefined();
    }
  });

  /*
    A KPI entry is aligned by `kpiIndex`, and the fixture's counts are fixed — `KpiSpec` is written in
    `Campaign`'s constructor and has no setter. Contiguous-from-zero is what makes `guideForKpi` find
    every row, so an off-by-one in a hand-written entry is caught here rather than as a silent gap.
    The length assertions matter for the same reason: `sanitizeGuide` truncates rather than rejecting,
    so an over-long line would ship as a sentence cut mid-word.
  */
  it("indexes every fixture KPI contiguously from zero, within the panel's caps", () => {
    const counts: Record<string, number> = {
      "0x5C42acDAff94B3d15D48Ebf76c9a48e3A55888a3": 3,
      "0x6dC20396480557E001ea986BD765D81A7279DeD5": 2,
      "0x938E0c2Ef6E3ED250D1D004050091f0A26076fEC": 2,
      "0xaBC517769c86a2122bCe19422b7863296c8BCF90": 2,
      [AAVE]: 2,
    };

    for (const [address, count] of Object.entries(counts)) {
      const guide = catalogGuide(BASE_SEPOLIA, address);
      expect(guide?.summary?.length, address).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);

      const kpis = guide?.kpis ?? [];
      expect(kpis.map((k) => k.kpiIndex), address).toEqual([...Array(count).keys()]);
      for (const kpi of kpis) {
        expect(kpi.action?.length, address).toBeLessThanOrEqual(MAX_ACTION_LENGTH);
      }
    }
  });
});

describe("resolveCampaignGuide", () => {
  it("prefers a stored guide over the catalog, wholesale", () => {
    const resolved = resolveCampaignGuide({
      campaign: AAVE,
      chainId: BASE_SEPOLIA,
      stored: {summary: "Ours, not the catalog's."},
    });

    expect(resolved).toEqual({provenance: "project", summary: "Ours, not the catalog's."});
    // Not merged: no catalog KPI prose leaks in under a "project" label.
    expect(resolved?.kpis).toBeUndefined();
  });

  it("falls back to the catalog when nothing is stored", () => {
    for (const stored of [undefined, null, {}, {summary: "   "}]) {
      const resolved = resolveCampaignGuide({campaign: AAVE, chainId: BASE_SEPOLIA, stored});
      expect(resolved?.provenance).toBe("catalog");
    }
  });

  it("returns null when neither source has anything", () => {
    expect(resolveCampaignGuide({campaign: UNSEEDED, chainId: BASE_SEPOLIA})).toBeNull();
    expect(resolveCampaignGuide({campaign: AAVE, chainId: 31337})).toBeNull();
    expect(resolveCampaignGuide({campaign: undefined, chainId: undefined})).toBeNull();
  });

  /*
    A store file is editable by hand and `BONEY_GUIDE_STORE` can point anywhere, so the read path
    sanitizes too. Without this a `javascript:` URL only had to get past the write route once.
  */
  it("sanitizes a stored guide on the way out", () => {
    const resolved = resolveCampaignGuide({
      campaign: AAVE,
      chainId: BASE_SEPOLIA,
      stored: {
        kpis: [{action: "Supply.", kpiIndex: 0, url: "javascript:alert(1)"}],
        siteUrl: "javascript:alert(1)",
        summary: "Fine.",
      },
    });

    expect(resolved?.siteUrl).toBeUndefined();
    expect(resolved?.kpis?.[0]).toEqual({action: "Supply.", kpiIndex: 0});
  });

  /*
    A stored guide whose every field is dropped must not win: it would render an empty card and hide
    the catalog entry behind it.
  */
  it("does not let an all-dropped stored guide beat the catalog", () => {
    const resolved = resolveCampaignGuide({
      campaign: AAVE,
      chainId: BASE_SEPOLIA,
      stored: {siteUrl: "http://example.com", summary: ""},
    });

    expect(resolved?.provenance).toBe("catalog");
  });
});

describe("guideForKpi", () => {
  const guide = {kpis: [{action: "Second.", kpiIndex: 1}]};

  it("finds an entry by index and tolerates every absent shape", () => {
    expect(guideForKpi(guide, 1)?.action).toBe("Second.");
    // An index the guide does not describe, a guide with no KPI array, and no guide at all.
    expect(guideForKpi(guide, 0)).toBeUndefined();
    expect(guideForKpi({summary: "No KPIs."}, 0)).toBeUndefined();
    expect(guideForKpi(null, 0)).toBeUndefined();
    expect(guideForKpi(undefined, 0)).toBeUndefined();
  });

  it("takes the first of duplicate indices", () => {
    const dupes = {kpis: [{action: "First.", kpiIndex: 0}, {action: "Shadowed.", kpiIndex: 0}]};
    expect(guideForKpi(dupes, 0)?.action).toBe("First.");
  });
});

describe("sanitizeGuide", () => {
  it("trims, caps, and drops what it cannot render", () => {
    const guide = sanitizeGuide({
      kpis: [
        {action: "  Wrap ETH.  ", kpiIndex: 0, url: "https://example.com/wrap"},
        // Neither an action nor a usable URL, so the row would only repeat the chain.
        {action: "   ", kpiIndex: 1, url: "http://example.com"},
        // Not an index.
        {action: "Nope.", kpiIndex: -1},
        {action: "Nope.", kpiIndex: 1.5},
      ],
      siteUrl: "https://example.com",
      summary: "  A campaign.  ",
    });

    expect(guide).toEqual({
      kpis: [{action: "Wrap ETH.", kpiIndex: 0, url: "https://example.com/wrap"}],
      siteUrl: "https://example.com/",
      summary: "A campaign.",
    });
  });

  it("caps rather than rejects an over-long summary or action", () => {
    const guide = sanitizeGuide({
      kpis: [{action: "b".repeat(MAX_ACTION_LENGTH + 50), kpiIndex: 0}],
      summary: "a".repeat(MAX_SUMMARY_LENGTH + 50),
    });

    expect(guide.summary).toHaveLength(MAX_SUMMARY_LENGTH);
    expect(guide.kpis?.[0].action).toHaveLength(MAX_ACTION_LENGTH);
  });

  it("survives junk without throwing", () => {
    expect(sanitizeGuide(undefined)).toEqual({});
    expect(sanitizeGuide(null)).toEqual({});
    expect(sanitizeGuide({kpis: "not an array"})).toEqual({});
    expect(sanitizeGuide({kpis: [null, 7, "x"]})).toEqual({});
  });
});

describe("isEmptyGuide", () => {
  it("counts a guide with only whitespace as empty", () => {
    expect(isEmptyGuide({})).toBe(true);
    expect(isEmptyGuide({summary: "  "})).toBe(true);
    expect(isEmptyGuide({kpis: []})).toBe(true);
    expect(isEmptyGuide({kpis: [{kpiIndex: 0}]})).toBe(true);
    expect(isEmptyGuide({summary: "Real."})).toBe(false);
    expect(isEmptyGuide({siteUrl: "https://example.com/"})).toBe(false);
    expect(isEmptyGuide({kpis: [{action: "Do it.", kpiIndex: 0}]})).toBe(false);
  });
});

describe("guideDraftFrom", () => {
  it("reopens a guide with one row per KPI, in index order", () => {
    const draft = guideDraftFrom(
      {
        // Out of order and with index 0 undescribed, which is what a real stored guide looks like.
        kpis: [{action: "Third.", kpiIndex: 2}, {action: "Second.", kpiIndex: 1, url: "https://b.example/"}],
        siteUrl: "https://a.example/",
        summary: "Ours.",
      },
      3,
    );

    expect(draft).toEqual({
      kpis: [
        {action: "", url: ""},
        {action: "Second.", url: "https://b.example/"},
        {action: "Third.", url: ""},
      ],
      siteUrl: "https://a.example/",
      summary: "Ours.",
    });
  });

  /*
    The campaign's KPI count wins, not the guide's. A stored entry past it belongs to no KPI the page can
    render, and a KPI the guide never described still needs a blank row to type into.
  */
  it("takes its length from the campaign, not the guide", () => {
    expect(guideDraftFrom({kpis: [{action: "Gone.", kpiIndex: 5}]}, 2)).toEqual({
      kpis: [{action: "", url: ""}, {action: "", url: ""}],
      siteUrl: "",
      summary: "",
    });
  });

  it("treats no guide as an empty draft", () => {
    expect(guideDraftFrom(null, 2)).toEqual(emptyGuideDraft(2));
    expect(guideDraftFrom(undefined, 0)).toEqual(emptyGuideDraft(0));
  });

  /*
    The editor's whole loop: open a published guide, change nothing, publish again, and get the same
    bytes back — otherwise a no-op edit would silently rewrite what a referral is shown.
  */
  it("round-trips through guideFromDraft unchanged", () => {
    const guide = {
      kpis: [{action: "First.", kpiIndex: 0, url: "https://a.example/"}, {action: "Second.", kpiIndex: 1}],
      siteUrl: "https://b.example/",
      summary: "Ours.",
    };

    expect(guideFromDraft(guideDraftFrom(guide, 2))).toEqual(guide);
    // And for the catalog, which a project takes over by editing.
    const catalog = catalogGuide(BASE_SEPOLIA, AAVE)!;
    expect(guideFromDraft(guideDraftFrom(catalog, 2))).toEqual(catalog);
  });
});

describe("guideFromDraft", () => {  it("aligns kpiIndex to the draft's array position", () => {
    const draft: GuideDraft = {
      kpis: [
        // Blank, so it drops — and the entry after it must keep index 1 rather than sliding to 0.
        {action: "", url: ""},
        {action: "Second KPI.", url: "https://example.com"},
      ],
      siteUrl: "",
      summary: "",
    };

    expect(guideFromDraft(draft)).toEqual({
      kpis: [{action: "Second KPI.", kpiIndex: 1, url: "https://example.com/"}],
    });
  });

  it("round-trips an empty draft to an empty guide", () => {
    expect(guideFromDraft(emptyGuideDraft(3))).toEqual({});
    expect(isEmptyGuide(guideFromDraft(emptyGuideDraft(3)))).toBe(true);
  });
});

describe("validateGuideDraft", () => {
  it("is silent on an empty draft", () => {
    expect(validateGuideDraft(emptyGuideDraft(2))).toEqual([]);
  });

  it("names the field a dropped URL came from", () => {
    const issues = validateGuideDraft({
      kpis: [{action: "", url: "http://example.com"}],
      siteUrl: "javascript:alert(1)",
      summary: "",
    });

    expect(issues.map((i) => i.path)).toEqual(["guide.siteUrl", "guide.kpis.0.url"]);
    for (const issue of issues) expect(issue.message).toContain("https://");
  });

  it("warns about length without rejecting it", () => {
    const issues = validateGuideDraft({
      kpis: [{action: "b".repeat(MAX_ACTION_LENGTH + 1), url: ""}],
      siteUrl: "",
      summary: "a".repeat(MAX_SUMMARY_LENGTH + 1),
    });

    expect(issues.map((i) => i.path)).toEqual(["guide.summary", "guide.kpis.0.action"]);
  });
});

describe("canonicalGuideMessage", () => {
  const guide = {
    kpis: [{action: "Second.", kpiIndex: 1}, {action: "First.", kpiIndex: 0}],
    siteUrl: "https://example.com/",
    summary: "A campaign.",
  };

  /*
    The server rebuilds this from its own sanitized copy, so the two only agree if key order and KPI
    order are fixed rather than inherited from whatever object the caller happened to build.
  */
  it("is stable under key and KPI order", () => {
    const reordered = {
      summary: "A campaign.",
      kpis: [{kpiIndex: 0, action: "First."}, {kpiIndex: 1, action: "Second."}],
      siteUrl: "https://example.com/",
    };

    expect(canonicalGuideMessage({campaign: AAVE, chainId: BASE_SEPOLIA, guide: reordered})).toBe(
      canonicalGuideMessage({campaign: AAVE, chainId: BASE_SEPOLIA, guide}),
    );
  });

  it("signs the sanitized guide, not what was typed", () => {
    // The dropped URL must not appear in the signed bytes, or the project would be signing for
    // something the store never holds.
    const message = canonicalGuideMessage({
      campaign: AAVE,
      chainId: BASE_SEPOLIA,
      guide: {siteUrl: "javascript:alert(1)", summary: "  A campaign.  "},
    });

    expect(message).not.toContain("javascript");
    expect(message).toContain('"summary":"A campaign."');
  });

  /*
    Both are in the message because a signature is otherwise liftable: onto the same campaign address
    on another chain, or onto a different campaign entirely.
  */
  it("binds the chain and the campaign, case-insensitively", () => {
    const base = canonicalGuideMessage({campaign: AAVE, chainId: BASE_SEPOLIA, guide});

    expect(base).toContain(`campaign: ${AAVE.toLowerCase()}`);
    expect(base).toBe(
      canonicalGuideMessage({campaign: AAVE.toLowerCase(), chainId: BASE_SEPOLIA, guide}),
    );
    expect(base).not.toBe(canonicalGuideMessage({campaign: AAVE, chainId: 11155111, guide}));
    expect(base).not.toBe(canonicalGuideMessage({campaign: UNSEEDED, chainId: BASE_SEPOLIA, guide}));
  });
});
