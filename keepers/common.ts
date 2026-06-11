import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

export const BASE_RPC = process.env.BASE_RPC ?? "http://localhost:8899";
export const BASE_WS = process.env.BASE_WS ?? "ws://localhost:8900";
export const ER_RPC = process.env.ER_RPC ?? "http://localhost:7799";
export const ER_WS = process.env.ER_WS ?? "ws://localhost:7800";
export const VALIDATOR =
  process.env.ER_VALIDATOR ?? "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev";
export const DAEMON_PORT = Number(process.env.DAEMON_PORT ?? 8787);
export const CLUSTER = process.env.CLUSTER ?? "localnet";

export interface MarketDef {
  idx: number;
  symbol: string;
  display: number;
  /** synthetic random-walk params */
  base: number;
  vol: number; // per-tick sigma as a fraction of price
  /** symbol on Flash Trade's /v2/prices, when sourcing real prices */
  flashSymbol: string;
}

export const MARKETS: MarketDef[] = [
  { idx: 0, symbol: "SOL", display: 2, base: 151.4, vol: 0.00022, flashSymbol: "SOL" },
  { idx: 1, symbol: "BTC", display: 0, base: 104_650, vol: 0.00012, flashSymbol: "BTC" },
  { idx: 2, symbol: "ETH", display: 2, base: 3_921, vol: 0.00016, flashSymbol: "ETH" },
  { idx: 3, symbol: "NVDA", display: 2, base: 188.3, vol: 0.00014, flashSymbol: "NVDA" },
  { idx: 4, symbol: "XAU", display: 2, base: 3_345, vol: 0.00007, flashSymbol: "XAU" },
  { idx: 5, symbol: "EUR", display: 4, base: 1.0865, vol: 0.00004, flashSymbol: "EUR" },
];

export const EXPO = -8;
export const toRaw = (price: number) => new BN(Math.round(price * 1e8));

export function loadAdmin(): Keypair {
  const p = process.env.ADMIN_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

export function loadIdl(): any {
  const p = path.join(import.meta.dirname, "../program/target/idl/wick.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function symbolBytes(s: string): number[] {
  const out = new Array(12).fill(0);
  Buffer.from(s).forEach((b, i) => {
    if (i < 12) out[i] = b;
  });
  return out;
}

export interface Ctx {
  admin: Keypair;
  base: Connection;
  er: Connection;
  program: Program;
  programId: PublicKey;
}

export function makeCtx(): Ctx {
  const admin = loadAdmin();
  const base = new Connection(BASE_RPC, { wsEndpoint: BASE_WS, commitment: "confirmed" });
  const er = new Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" });
  const idl = loadIdl();
  const provider = new AnchorProvider(base, new Wallet(admin), { commitment: "confirmed" });
  const program = new Program(idl, provider);
  return { admin, base, er, program, programId: program.programId };
}

export function pdas(programId: PublicKey) {
  const pda = (...seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds as Buffer[], programId)[0];
  return {
    config: pda(Buffer.from("config")),
    house: pda(Buffer.from("house")),
    vault: pda(Buffer.from("vault_token")),
    market: (idx: number) => pda(Buffer.from("market"), Buffer.from([idx])),
    book: (idx: number) => pda(Buffer.from("book"), Buffer.from([idx])),
    feed: (symbol: string) => pda(Buffer.from("feed"), Buffer.from(symbolBytes(symbol))),
  };
}

/** Send a tx to the ER signed by the admin (gasless; cached blockhash). */
let cachedHash: { v: string; t: number } | null = null;

export async function sendER(
  ctx: Ctx,
  tx: import("@solana/web3.js").Transaction
): Promise<string> {
  if (!cachedHash || Date.now() - cachedHash.t > 8000) {
    cachedHash = { v: (await ctx.er.getLatestBlockhash()).blockhash, t: Date.now() };
  }
  tx.feePayer = ctx.admin.publicKey;
  tx.recentBlockhash = cachedHash.v;
  tx.sign(ctx.admin);
  return ctx.er.sendRawTransaction(tx.serialize(), { skipPreflight: true });
}
