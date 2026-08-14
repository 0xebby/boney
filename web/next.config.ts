import {readFileSync} from "node:fs";
import {parseEnv} from "node:util";
import path from "node:path";
import type {NextConfig} from "next";

// The attestor signing key lives in the repo-root `.env`, alongside the deploy keys that foundry
// reads, so there is one place to rotate it. Next only loads `.env*` from the app directory, so
// pull the root file in by hand.
//
// Only ATTESTOR_PRIVATE_KEY is copied across. The root file also holds PRIVATE_KEY, the funded
// deployer/owner account — the web app has no reason to sign with it, and a key that is never
// loaded cannot leak through a server-side mistake.
//
// Assigning to process.env here (rather than the `env` config key) keeps this server-only: `env`
// values are inlined into the client bundle unconditionally, which would publish the key.
function loadRootAttestorKey() {
  if (process.env.ATTESTOR_PRIVATE_KEY) return; // An explicit override already won.
  try {
    const parsed = parseEnv(readFileSync(path.join(process.cwd(), "..", ".env"), "utf8"));
    if (parsed.ATTESTOR_PRIVATE_KEY) process.env.ATTESTOR_PRIVATE_KEY = parsed.ATTESTOR_PRIVATE_KEY;
  } catch {
    // No root .env — /api/attest reports `attestor_unconfigured`, which is the accurate state.
  }
}

loadRootAttestorKey();

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
