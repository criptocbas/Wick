export interface MarketInfo {
  idx: number;
  symbol: string;
  kind: number; // 0 = MagicBlock Pyth Lazer, 1 = WickFeed
  feed: string;
  /** decimal places to show in the UI */
  display: number;
}

export interface ChainConfig {
  cluster: string;
  baseRpc: string;
  baseWs: string;
  erRpc: string;
  erWs: string;
  /** wick daemon (faucet + price pusher) */
  daemon: string;
  mint: string;
  validator: string;
  markets: MarketInfo[];
}

/** Written by `setup-localnet.ts` (or the devnet variant) into app/public/. */
export async function loadChainConfig(): Promise<ChainConfig> {
  const res = await fetch("/chain-config.json", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(
      "chain-config.json not found — run the setup script first (see README)"
    );
  }
  return res.json();
}

export const TOKEN_DECIMALS = 6;
export const toUnits = (ui: number) => Math.round(ui * 10 ** TOKEN_DECIMALS);
export const toUi = (units: number) => units / 10 ** TOKEN_DECIMALS;
