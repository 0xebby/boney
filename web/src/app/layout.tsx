import type {Metadata} from "next";
import "./globals.css";
import {Providers} from "@/components/Providers";
import {AppShell} from "@/components/AppShell";

export const metadata: Metadata = {
  title: "Boney Protocol",
  description:
    "The accountability layer for Web3 growth. Escrowed, performance-based campaigns with on-chain verification.",
};

export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return (
    // The palette is a selected dark theme, not an inverted light one, so the app declares
    // dark up front rather than deriving it from the OS preference.
    <html lang="en" className="h-full">
      <body className="min-h-full">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
