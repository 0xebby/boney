import {ImageResponse} from "next/og";
import {loadPublicCard} from "@/lib/cardServer";
import {parseCardWallet, subjectLabel} from "@/lib/publicCard";
import {shortAddress} from "@/lib/format";

/**
 * The share image for `/b/<wallet>` — the bone, as a 1200×630 PNG.
 *
 * ## Why this is written in inline styles and not the design system
 *
 * `ImageResponse` renders through Satori, which is not a browser: it supports a subset of CSS, has no
 * cascade and no custom properties, and Tailwind's classes and `globals.css`'s `--brand` tokens do not
 * exist here. So every colour below is the hex value from `globals.css`, copied deliberately, and every
 * container states `display: flex` — Satori errors on a multi-child div without it rather than assuming
 * block layout.
 *
 * No custom font is loaded. The app's faces come from `next/font/google`, and fetching a TTF at image
 * time would add a network dependency — and a failure mode — to the one asset whose whole job is to
 * render reliably for a crawler. Satori's built-in font is used instead; nobody compares a share card's
 * typeface side by side with the page's.
 *
 * ## The fail-soft rule, in the place it matters most
 *
 * No score, no number. No history, no counts. **Never a zero.** A share image is the most-forwarded
 * artefact in the system and the one nobody will see a caveat next to, so a figure that only exists
 * because a fetch failed would be a claim about a person travelling further than any other claim the app
 * makes. Each block below is present only when its data is.
 */

export const alt = "A Boneyard promoter card — BoneyScore, rank, and verified campaign history";
export const size = {width: 1200, height: 630};
export const contentType = "image/png";

/** From `globals.css`. Satori resolves no custom properties, so the values are inlined. */
const PLANE = "#0a0a09";
const SURFACE_2 = "#1b1a17";
const BRAND = "#ffc800";
const INK = "#ffe9a3";
const INK_MUTED = "#9a8f63";
const HAIRLINE = "rgba(255, 200, 0, 0.28)";

/** The bone, as the same four lobes and a shaft that `ui/Bone.tsx` draws. */
function Bone({width, opacity, color}: {width: number; opacity: number; color: string}) {
  return (
    <svg
      width={width}
      height={(width * 20) / 32}
      viewBox="0 0 32 20"
      fill={color}
      style={{opacity}}
    >
      <circle cx="6" cy="6.6" r="4.7" />
      <circle cx="6" cy="13.4" r="4.7" />
      <circle cx="26" cy="6.6" r="4.7" />
      <circle cx="26" cy="13.4" r="4.7" />
      <rect x="6" y="6.6" width="20" height="6.8" />
    </svg>
  );
}

export default async function Image({params}: {params: Promise<{wallet: string}>}) {
  const wallet = parseCardWallet((await params).wallet);

  // The route is reachable with a path the page 404s. Render the mark alone rather than erroring: a
  // broken image in an embed looks like the site is down.
  if (!wallet) return new ImageResponse(<Fallback />, size);

  const card = await loadPublicCard(wallet);
  const scored = card.score.kind === "scored" ? card.score : undefined;
  const history = card.history;
  const level = history?.level;

  // A wallet that has genuinely joined nothing gets a label, not a row of zeros. Both are true; only
  // one of them is worth forwarding.
  const counts =
    history && history.campaignsJoined > 0
      ? [
          {value: history.campaignsJoined.toLocaleString(), label: "CAMPAIGNS"},
          {value: history.tiers.toLocaleString(), label: "TIERS CROSSED"},
          {value: history.referrals.toLocaleString(), label: "REFERRALS"},
          {value: history.actions.toLocaleString(), label: "ACTIONS VERIFIED"},
        ]
      : [];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: PLANE,
          padding: 64,
          position: "relative",
        }}
      >
        {/*
          Watermark. Absolute so it does not participate in the column's spacing, and placed in the one
          band nothing else occupies — right of the score, below the level notches, above the count row.
          It was bleeding off the bottom-right corner, which put its shaft behind the opaque count tiles
          and left the two lobe pairs reading as a pair of unrelated blobs. A mark that does not read as
          the mark is worse than no mark.
        */}
        <div style={{position: "absolute", right: 56, top: 172, display: "flex"}}>
          <Bone width={360} opacity={0.09} color={BRAND} />
        </div>

        <div style={{display: "flex", justifyContent: "space-between", alignItems: "flex-start"}}>
          <div style={{display: "flex", flexDirection: "column"}}>
            <div style={{fontSize: 22, letterSpacing: 4, color: BRAND, fontWeight: 700}}>
              BONEYCARD
            </div>
            <div style={{fontSize: 44, color: INK, marginTop: 8}}>
              {subjectLabel(wallet, card.handle)}
            </div>
            {/* The address as well as the handle: a handle is an alias, this is the identity. */}
            {card.handle ? (
              <div style={{fontSize: 22, color: INK_MUTED, marginTop: 4}}>
                {shortAddress(wallet, 10, 8)}
              </div>
            ) : null}
          </div>

          {level !== undefined ? <Level level={level} /> : null}
        </div>

        {scored ? (
          <div style={{display: "flex", flexDirection: "column"}}>
            <div style={{fontSize: 20, letterSpacing: 3, color: BRAND, fontWeight: 700}}>
              BONEYSCORE
            </div>
            <div style={{display: "flex", alignItems: "flex-end"}}>
              <div style={{fontSize: 132, color: INK, lineHeight: 1}}>
                {scored.score.total.toLocaleString()}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 30,
                  color: BRAND,
                  marginLeft: 24,
                  marginBottom: 18,
                  letterSpacing: 2,
                }}
              >
                {scored.rank.name.toUpperCase()}
              </div>
            </div>
            <div style={{fontSize: 22, color: INK_MUTED, marginTop: 6}}>
              {"credibility & reach — not delivery"}
            </div>
          </div>
        ) : (
          // No claimed profile, or Ethos was unreachable. Neither is a zero.
          <div style={{display: "flex", fontSize: 40, color: INK_MUTED}}>
            Promoter card on Boneyard
          </div>
        )}

        {counts.length > 0 ? (
          <div
            style={{
              display: "flex",
              gap: 24,
              borderTop: `2px solid ${HAIRLINE}`,
              paddingTop: 28,
            }}
          >
            {counts.map((count) => (
              <div
                key={count.label}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  background: SURFACE_2,
                  borderRadius: 12,
                  padding: "16px 24px",
                  flexGrow: 1,
                }}
              >
                <div style={{fontSize: 16, letterSpacing: 2, color: BRAND, fontWeight: 700}}>
                  {count.label}
                </div>
                <div style={{fontSize: 52, color: INK, marginTop: 4}}>{count.value}</div>
              </div>
            ))}
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              fontSize: 24,
              color: INK_MUTED,
              borderTop: `2px solid ${HAIRLINE}`,
              paddingTop: 28,
            }}
          >
            {history ? "New promoter — no campaigns yet" : "boneyard"}
          </div>
        )}
      </div>
    ),
    size,
  );
}

/** Level notches. Filled to the level, faint after it — and the number, so the shape is never the only carrier. */
function Level({level}: {level: number}) {
  return (
    <div style={{display: "flex", flexDirection: "column", alignItems: "flex-end"}}>
      <div style={{display: "flex", gap: 10}}>
        {[1, 2, 3, 4, 5].map((notch) => (
          <Bone key={notch} width={64} opacity={notch <= level ? 1 : 0.18} color={BRAND} />
        ))}
      </div>
      <div style={{fontSize: 24, letterSpacing: 3, color: INK_MUTED, marginTop: 12}}>
        {/*
          One template string, not `BONE LEVEL {level}`. JSX would make that two children — a text node
          and an expression — and Satori rejects a multi-child element without an explicit `display`,
          which surfaces at request time as "failed to pipe response" and a 500 on the image.
        */}
        {`BONE LEVEL ${level}`}
      </div>
    </div>
  );
}

/** Nothing to show — a malformed path. The mark, and no claims. */
function Fallback() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: PLANE,
      }}
    >
      <Bone width={360} opacity={0.9} color={BRAND} />
      <div style={{fontSize: 44, color: INK, marginTop: 32, letterSpacing: 4}}>BONEYCARD</div>
    </div>
  );
}
