import { AnchorProvider, BN, EventParser, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "./idl/wick.json";
import { KeypairWallet } from "./wallet";
import type { ChainConfig, MarketInfo } from "./config";

export const DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
);

export const DIRECTION_DOWN = 0;
export const DIRECTION_UP = 1;

export interface Bet {
  status: number;
  direction: number;
  marketIdx: number;
  stake: number;
  potentialProfit: number;
  strike: number; // raw oracle units
  expo: number;
  placedMs: number;
  expiryMs: number;
  slot: number; // index in the bets array
}

export interface UserState {
  authority: PublicKey;
  balance: number;
  openBets: number;
  wins: number;
  losses: number;
  pushes: number;
  streak: number;
  bestStreak: number;
  totalWagered: number;
  pnl: number;
  bets: Bet[];
}

export interface FeedState {
  symbol: string;
  price: number; // ui price (already scaled by expo)
  raw: number;
  expo: number;
  tsMs: number;
}

export interface Verdict {
  outcome: "win" | "loss" | "push";
  stake: number;
  payout: number;
  marketIdx: number;
}

function decodeUser(coder: Program["coder"], data: Buffer): UserState {
  const u = coder.accounts.decode("userAccount", data);
  return {
    authority: u.authority,
    balance: (u.balance as BN).toNumber(),
    openBets: u.openBets,
    wins: u.wins,
    losses: u.losses,
    pushes: u.pushes,
    streak: u.streak,
    bestStreak: u.bestStreak,
    totalWagered: (u.totalWagered as BN).toNumber(),
    pnl: (u.pnl as BN).toNumber(),
    bets: (u.bets as any[]).map((b, slot) => ({
      status: b.status,
      direction: b.direction,
      marketIdx: b.marketIdx,
      stake: (b.stake as BN).toNumber(),
      potentialProfit: (b.potentialProfit as BN).toNumber(),
      strike: (b.strike as BN).toNumber(),
      expo: b.expo,
      placedMs: (b.placedMs as BN).toNumber(),
      expiryMs: (b.expiryMs as BN).toNumber(),
      slot,
    })),
  };
}

export function decodeFeed(
  coder: Program["coder"],
  market: MarketInfo,
  data: Buffer
): FeedState {
  if (market.kind === 1) {
    const f = coder.accounts.decode("wickFeed", data);
    const raw = (f.price as BN).toNumber();
    return {
      symbol: market.symbol,
      raw,
      expo: f.expo,
      price: raw * 10 ** f.expo,
      tsMs: (f.tsMs as BN).toNumber(),
    };
  }
  // MagicBlock Pyth Lazer (PriceUpdateV2 layout): price i64 @73, expo i32 @89
  // (stored as a positive magnitude: 8 ⇒ ×10⁻⁸), publish_time (seconds) @93
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const raw = Number(dv.getBigInt64(73, true));
  const expo = dv.getInt32(89, true);
  const tsS = Number(dv.getBigInt64(93, true));
  return {
    symbol: market.symbol,
    raw,
    expo,
    price: raw * 10 ** (expo > 0 ? -expo : expo),
    tsMs: tsS * 1000,
  };
}

export class WickClient {
  readonly base: Connection;
  readonly er: Connection;
  readonly wallet: KeypairWallet;
  readonly program: Program;
  readonly events: EventParser;
  readonly cfg: ChainConfig;

  readonly configPda: PublicKey;
  readonly housePda: PublicKey;
  readonly userPda: PublicKey;

  private erBlockhash: { value: string; fetched: number } | null = null;

  constructor(cfg: ChainConfig, burner: Keypair) {
    this.cfg = cfg;
    this.base = new Connection(cfg.baseRpc, {
      wsEndpoint: cfg.baseWs,
      commitment: "confirmed",
    });
    this.er = new Connection(cfg.erRpc, {
      wsEndpoint: cfg.erWs,
      commitment: "confirmed",
    });
    this.wallet = new KeypairWallet(burner);
    const provider = new AnchorProvider(this.base, this.wallet, {
      commitment: "confirmed",
    });
    this.program = new Program(idl as any, provider);
    this.events = new EventParser(this.program.programId, this.program.coder);

    [this.configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      this.program.programId
    );
    [this.housePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("house")],
      this.program.programId
    );
    [this.userPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user"), burner.publicKey.toBuffer()],
      this.program.programId
    );
  }

  marketPda(idx: number): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("market"), Buffer.from([idx])],
      this.program.programId
    )[0];
  }

  bookPda(idx: number): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("book"), Buffer.from([idx])],
      this.program.programId
    )[0];
  }

  get ata(): PublicKey {
    return getAssociatedTokenAddressSync(
      new PublicKey(this.cfg.mint),
      this.wallet.publicKey
    );
  }

  // ── ER send path (the hot path: cached blockhash, raw send) ──

  private async getErBlockhash(): Promise<string> {
    const now = performance.now();
    if (!this.erBlockhash || now - this.erBlockhash.fetched > 8_000) {
      const { blockhash } = await this.er.getLatestBlockhash("confirmed");
      this.erBlockhash = { value: blockhash, fetched: now };
    }
    return this.erBlockhash.value;
  }

  /** Pre-warm the blockhash cache so the first tap is as fast as the rest. */
  warm(): void {
    void this.getErBlockhash();
  }

  /** Send to the ER, return { sig, ms }. */
  async sendER(tx: Transaction): Promise<{ sig: string; ms: number }> {
    tx.feePayer = this.wallet.publicKey;
    tx.recentBlockhash = await this.getErBlockhash();
    await this.wallet.signTransaction(tx);
    const t0 = performance.now();
    const sig = await this.er.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
    });
    await this.confirmER(sig);
    return { sig, ms: Math.round(performance.now() - t0) };
  }

  private async confirmER(sig: string, timeoutMs = 8_000): Promise<void> {
    const t0 = performance.now();
    for (;;) {
      const st = await this.er.getSignatureStatus(sig);
      const v = st.value;
      if (v) {
        if (v.err) {
          let logs = "";
          try {
            const tx = await this.er.getTransaction(sig, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });
            logs = (tx?.meta?.logMessages ?? []).join("\n");
          } catch {
            /* best effort */
          }
          throw new Error(`ER tx failed: ${JSON.stringify(v.err)}\n${logs}`);
        }
        if (
          v.confirmationStatus === "processed" ||
          v.confirmationStatus === "confirmed" ||
          v.confirmationStatus === "finalized"
        )
          return;
      }
      if (performance.now() - t0 > timeoutMs) throw new Error("ER confirm timeout");
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  async sendBase(tx: Transaction): Promise<string> {
    tx.feePayer = this.wallet.publicKey;
    tx.recentBlockhash = (await this.base.getLatestBlockhash()).blockhash;
    await this.wallet.signTransaction(tx);
    const sig = await this.base.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
    });
    await this.base.confirmTransaction(sig, "confirmed");
    return sig;
  }

  // ── account state ─────────────────────────────────────────────

  async isDelegated(): Promise<boolean> {
    const info = await this.base.getAccountInfo(this.userPda);
    return !!info && info.owner.equals(DELEGATION_PROGRAM_ID);
  }

  async userExists(): Promise<boolean> {
    return !!(await this.base.getAccountInfo(this.userPda));
  }

  async fetchUser(layer: "base" | "er"): Promise<UserState | null> {
    const conn = layer === "er" ? this.er : this.base;
    const info = await conn.getAccountInfo(this.userPda);
    if (!info) return null;
    return decodeUser(this.program.coder, info.data as Buffer);
  }

  async solBalance(): Promise<number> {
    return (await this.base.getBalance(this.wallet.publicKey)) / LAMPORTS_PER_SOL;
  }

  subscribeUser(cb: (u: UserState) => void): number {
    return this.er.onAccountChange(
      this.userPda,
      (info) => cb(decodeUser(this.program.coder, info.data as Buffer)),
      "processed"
    );
  }

  subscribeFeed(market: MarketInfo, cb: (f: FeedState) => void): number {
    return this.er.onAccountChange(
      new PublicKey(market.feed),
      (info) => cb(decodeFeed(this.program.coder, market, info.data as Buffer)),
      "processed"
    );
  }

  async fetchFeed(market: MarketInfo): Promise<FeedState | null> {
    const info = await this.er.getAccountInfo(new PublicKey(market.feed));
    if (!info) return null;
    return decodeFeed(this.program.coder, market, info.data as Buffer);
  }

  // ── instructions ──────────────────────────────────────────────

  async initUser(): Promise<void> {
    // burner == session key: one identity for L1 custody and ER taps
    await this.sendBase(
      await this.program.methods
        .initUser(this.wallet.publicKey)
        .accounts({ authority: this.wallet.publicKey })
        .transaction()
    );
  }

  async deposit(units: number): Promise<void> {
    await this.sendBase(
      await this.program.methods
        .deposit(new BN(units))
        .accounts({ authority: this.wallet.publicKey, from: this.ata })
        .transaction()
    );
  }

  async withdraw(units: number): Promise<void> {
    await this.sendBase(
      await this.program.methods
        .withdraw(new BN(units))
        .accounts({ authority: this.wallet.publicKey, to: this.ata })
        .transaction()
    );
  }

  async delegateUser(): Promise<void> {
    await this.sendBase(
      await this.program.methods
        .delegateUser()
        .accounts({ payer: this.wallet.publicKey, userAccount: this.userPda })
        .remainingAccounts([
          {
            pubkey: new PublicKey(this.cfg.validator),
            isSigner: false,
            isWritable: false,
          },
        ])
        .transaction()
    );
  }

  async placeBet(
    market: MarketInfo,
    direction: number,
    stakeUnits: number,
    durationS: number
  ): Promise<{ sig: string; ms: number }> {
    const tx = await this.program.methods
      .placeBet(direction, new BN(stakeUnits), durationS)
      .accounts({
        operator: this.wallet.publicKey,
        market: this.marketPda(market.idx),
        book: this.bookPda(market.idx),
        house: this.housePda,
        userAccount: this.userPda,
        feed: new PublicKey(market.feed),
      })
      .transaction();
    return this.sendER(tx);
  }

  async resolveBet(market: MarketInfo, betIdx: number): Promise<Verdict | null> {
    const tx = await this.program.methods
      .resolveBet(betIdx)
      .accounts({
        resolver: this.wallet.publicKey,
        market: this.marketPda(market.idx),
        book: this.bookPda(market.idx),
        house: this.housePda,
        userAccount: this.userPda,
        feed: new PublicKey(market.feed),
      })
      .transaction();
    const { sig } = await this.sendER(tx);
    try {
      const txInfo = await this.er.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      for (const ev of this.events.parseLogs(txInfo?.meta?.logMessages ?? [])) {
        if (ev.name === "betResolved") {
          const d = ev.data as any;
          return {
            outcome: d.outcome === 1 ? "win" : d.outcome === 0 ? "loss" : "push",
            stake: (d.stake as BN).toNumber(),
            payout: (d.payout as BN).toNumber(),
            marketIdx: d.marketIdx,
          };
        }
      }
    } catch {
      /* fall through — account subscription will still update state */
    }
    return null;
  }

  async undelegateUser(): Promise<void> {
    const tx = await this.program.methods
      .undelegateUser()
      .accounts({ payer: this.wallet.publicKey, userAccount: this.userPda })
      .transaction();
    await this.sendER(tx);
  }
}
