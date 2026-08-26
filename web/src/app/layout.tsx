import type {Metadata} from "next";
import {Bagel_Fat_One, Space_Grotesk} from "next/font/google";
import "./globals.css";
import {Providers} from "@/components/Providers";
import {AppShell} from "@/components/AppShell";
import {siteUrl} from "@/lib/site";

/**
 * Two faces, each with a job.
 *
 * Bagel Fat One is the playful one — a fat, rounded, bubble-lettered display face used for the
 * brand mark, page titles, and hero figures. Space Grotesk carries body and table text: its
 * figures are even-width, which is what a dense numeric table needs.
 *
 * Bagel Fat One ships a SINGLE weight (400). Anything wearing `.font-display` must therefore not
 * also carry a Tailwind weight utility — `font-extrabold` on a 400-only family makes the browser
 * synthesise a fake bold, which smears an already-heavy face. `.font-display` pins the weight
 * itself; see `globals.css`.
 *
 * `variable` rather than `className`, because both are consumed through `--font-*` custom
 * properties in `globals.css`. That lets Tailwind's `font-sans` and the `.font-display` class
 * resolve them without either face being hard-coded at a call site.
 */
const bagel = Bagel_Fat_One({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-bagel",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

/**
 * `base:app_id` claims every route for the Base app of that id, so the Base client renders a
 * shared Boneyard link — the marketplace, a campaign, a promoter — as an embedded mini app
 * rather than a plain URL. It lives here rather than on the campaign page because any route can
 * be the one that gets shared.
 *
 * It has no first-class field in the `Metadata` type, and `next/head` does not exist in the App
 * Router, so it goes through `other` — the escape hatch for arbitrary `<meta name>` tags.
 *
 * Metadata from nested segments is merged SHALLOWLY and duplicate keys are replaced, so a page
 * that exports its own `other` drops this tag for that route and has to repeat it. No page does
 * today. See `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md`.
 *
 * `metadataBase` is what makes the shared BoneyCard work. `/b/<wallet>` sets `openGraph.url` from
 * `cardPath`, and a relative metadata URL with no base is a build error — while an *inferred* base is
 * `http://localhost:3000`, which no crawler can fetch the share image from. See `lib/site.ts`.
 */
export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: "Boneyard",
  description: "Campaigns with rewards held in escrow and released as milestones are verified.",
  other: {"base:app_id": "695996314d3a403912ed8c02"},
};

export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return (
    // Yellow on black is the selected theme, not an inverted light one, so the app declares
    // dark up front rather than deriving it from the OS preference.
    <html lang="en" className={`h-full ${bagel.variable} ${spaceGrotesk.variable}`}>
      <body className="min-h-full">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
