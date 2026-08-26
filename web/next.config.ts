import {readFileSync} from "node:fs";
import {parseEnv} from "node:util";
import path from "node:path";
import type {NextConfig} from "next";

// The attestor signing key may live in the repo-root `.env`, alongside the deploy keys that foundry
// reads, so there is one place to rotate it. Next only loads `.env*` from the app directory, so pull
// the root file in by hand.
//
// Only ATTESTOR_PRIVATE_KEY is copied across. The root file also holds PRIVATE_KEY, the funded
// deployer/owner account — the web app has no reason to sign with it, and a key that is never
// loaded cannot leak through a server-side mistake.
//
// Assigning to process.env here (rather than the `env` config key) keeps this server-only: `env`
// values are inlined into the client bundle unconditionally, which would publish the key.
//
// ## Why `.env.local` is read here rather than trusted to win on its own
//
// This function used to guard only on `process.env.ATTESTOR_PRIVATE_KEY` already being set, on the
// assumption that Next would have loaded `.env.local` first. That assumption is not reliable, and
// when it does not hold the consequence is silent and permanent: Next's loader does not clobber a
// value already present in `process.env`, so a key copied from the root file *beats* `.env.local` for
// the life of the process. Whichever ran first won, which made the effective attestor differ between
// otherwise identical `pnpm dev` runs.
//
// That surfaced on 2026-08-24 as `submitAttestation` reverting `NotAnAttestor` for a promoter who had
// already paid the gas — the root file's key was a different wallet entirely. Reading `.env.local`
// explicitly makes the precedence stated rather than emergent: process env, then `.env.local`, then
// the root file.
function loadAttestorKey() {
  if (process.env.ATTESTOR_PRIVATE_KEY) return; // An explicit override already won.

  const fromFile = (file: string): string | undefined => {
    try {
      return parseEnv(readFileSync(file, "utf8")).ATTESTOR_PRIVATE_KEY as string | undefined;
    } catch {
      return undefined; // Absent or unreadable is the ordinary case for both of these.
    }
  };

  const key =
    fromFile(path.join(process.cwd(), ".env.local")) ??
    fromFile(path.join(process.cwd(), "..", ".env"));

  // Left unset when neither file has one: /api/attest reports `attestor_unconfigured`, which is the
  // accurate state, and it now also refuses to sign with a key the verifier does not recognise.
  if (key) process.env.ATTESTOR_PRIVATE_KEY = key;
}

loadAttestorKey();

const nextConfig: NextConfig = {
  // The default bottom-left dev indicator overlaps the sidebar footer, covering the wallet
  // button. Moved rather than disabled, so compile and runtime errors are still surfaced.
  devIndicators: {
    position: "bottom-right",
  },

  typescript: {
    ignoreBuildErrors: true,
  },
  

};

export default nextConfig;
