export const DEV_STUB_WALLET = "0x98405c5776a63547e7cb16000ba04ca53d9fb2f8" as const;

const ENV_KEY = "BONEY_STUB_WALLETS";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function parseEnv(): Set<string> {
  const raw = process.env[ENV_KEY];
  if (!raw) return new Set();

  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0 && ADDRESS_RE.test(value)),
  );
}

function persist(wallets: Set<string>) {
  process.env[ENV_KEY] = [...wallets].sort().join(",");
}

export function normalizeStubWallet(wallet: string): string | undefined {
  if (typeof wallet !== "string") return undefined;
  const value = wallet.trim().toLowerCase();
  return ADDRESS_RE.test(value) ? value : undefined;
}

export function addStubWallet(wallet: string): string {
  const normalized = normalizeStubWallet(wallet);
  if (!normalized) {
    throw new Error("Invalid wallet address.");
  }

  const wallets = parseEnv();
  wallets.add(normalized);
  persist(wallets);
  return normalized;
}

export function removeStubWallet(wallet: string): boolean {
  const normalized = normalizeStubWallet(wallet);
  if (!normalized) {
    return false;
  }

  const wallets = parseEnv();
  const existed = wallets.delete(normalized);
  persist(wallets);
  return existed;
}

export function listStubWallets(): string[] {
  return [...parseEnv()].sort();
}

export function isStubbedWallet(wallet: string | undefined): boolean {
  if (!wallet) return false;
  const normalized = normalizeStubWallet(wallet);
  return normalized ? parseEnv().has(normalized) : false;
}
