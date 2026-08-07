import type {Metadata} from "next";
import {Bagel_Fat_One, Space_Grotesk} from "next/font/google";
import "./globals.css";
import {Providers} from "@/components/Providers";
import {AppShell} from "@/components/AppShell";

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

export const metadata: Metadata = {
  title: "Boneyard",
  description: "Campaigns with rewards held in escrow and released as milestones are verified.",
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
