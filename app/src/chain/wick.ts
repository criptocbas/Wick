import { AnchorProvider, BN, EventParser, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "./idl/wick.json";
import { KeypairWallet } from "./wallet";
import type { ChainConfig, MarketInfo } from "./config";

export const DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
);
export const MAGIC_PROGRAM_ID2 = new PublicKey(
  "Magic11111111111111111111111111111111111111"
);
export const MAGIC_CONTEXT_ID = new PublicKey(
  "MagicContext1111111111111111111111111111111"
);

export const DIRECTION_DOWN = 0;
export const DIRECTION_UP = 1;

// Mirror the program's settlement constants (Config defaults / state.rs). Used
// only to decide, client-side, whether an expired bet should be resolved (a
// print landed in-window) or voided (the window closed unfilled).
export const RESOLVE_GRACE_MS = 3_000;
export const VOID_DELAY_MS = 2_000;

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

  /** The L1 escrow vault token account that custodies all collateral. */
  get vaultPda(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault_token")],
      this.program.programId
    )[0];
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  /** Solscan link honoring the cluster. */
  solscan(addr: PublicKey | string): string {
    const a = typeof addr === "string" ? addr : addr.toBase58();
    const c = this.cfg.cluster === "mainnet" ? "" : `?cluster=${this.cfg.cluster}`;
    return `https://solscan.io/account/${a}${c}`;
  }

  // ── ER send path (the hot path: cached blockhash, raw send) ──

  private async getErBlockhash(force = false): Promise<string> {
    const now = performance.now();
    if (force || !this.erBlockhash || now - this.erBlockhash.fetched > 8_000) {
      const { blockhash } = await this.er.getLatestBlockhash("confirmed");
      this.erBlockhash = { value: blockhash, fetched: now };
    }
    return this.erBlockhash.value;
  }

  /** Pre-warm the blockhash cache so the first tap is as fast as the rest. */
  warm(): void {
    void this.getErBlockhash();
  }

  /** Wait until the user account is fully delegated AND live on the ER, so the
   *  first trade doesn't race the delegation propagating into the rollup. */
  async waitUntilTradeReady(timeoutMs = 25_000): Promise<boolean> {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      try {
        if ((await this.isDelegated()) && (await this.fetchUser("er"))) {
          // a delegated, ER-visible account is writable on the rollup
          return true;
        }
      } catch {
        /* keep polling */
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    return false;
  }

  /** Send to the ER, return { sig, ms }. A cached blockhash can age out
   *  between taps; on a blockhash-expiry error, force-refresh and retry once. */
  async sendER(tx: Transaction): Promise<{ sig: string; ms: number }> {
    for (let attempt = 0; ; attempt++) {
      tx.feePayer = this.wallet.publicKey;
      tx.recentBlockhash = await this.getErBlockhash(attempt > 0);
      tx.signatures = [];
      await this.wallet.signTransaction(tx);
      const t0 = performance.now();
      try {
        const sig = await this.er.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
        });
        await this.confirmER(sig);
        return { sig, ms: Math.round(performance.now() - t0) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Retry only on a genuine blockhash-expiry, not on program errors whose
        // logs happen to contain the word "expired" (e.g. NotExpired).
        const blockhashStale =
          /BlockhashNotFound|block height exceeded|blockhash.*not.*found/i.test(msg);
        if (attempt < 1 && blockhashStale) continue;
        throw e;
      }
    }
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
    const { blockhash, lastValidBlockHeight } = await this.base.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    await this.wallet.signTransaction(tx);
    const sig = await this.base.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
    });
    const conf = await this.base.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    if (conf.value.err) {
      throw new Error(`L1 tx failed: ${JSON.stringify(conf.value.err)}`);
    }
    return sig;
  }

  /** Burner's wUSDC balance (UI units). */
  async tokenBalance(): Promise<number> {
    const res = await this.base.getTokenAccountBalance(this.ata).catch(() => null);
    return res?.value.uiAmount ?? 0;
  }

  /** Poll until the faucet's wUSDC has actually landed before depositing. */
  async waitForFunding(timeoutMs = 20_000): Promise<boolean> {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      if ((await this.tokenBalance()) > 0) return true;
      await new Promise((r) => setTimeout(r, 600));
    }
    return false;
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
    const build = () =>
      this.program.methods
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
    // The first trade can race the user delegation propagating into the ER
    // (transiently "InvalidWritableAccount"); retry briefly before surfacing.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendER(await build());
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < 4 && /InvalidWritableAccount|not.*delegat/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        throw e;
      }
    }
  }

  /** Best-effort: schedule an on-chain crank to auto-resolve a bet at expiry.
   *  Where the ER supports user cranks this makes settlement fully autonomous;
   *  where it doesn't, this throws and the optimistic resolver remains the path. */
  async armResolution(market: MarketInfo, betIdx: number): Promise<void> {
    const tx = await this.program.methods
      .armResolution(betIdx)
      .accounts({
        payer: this.wallet.publicKey,
        market: this.marketPda(market.idx),
        book: this.bookPda(market.idx),
        house: this.housePda,
        userAccount: this.userPda,
        feed: new PublicKey(market.feed),
        magicProgram: MAGIC_PROGRAM_ID2,
        magicContext: MAGIC_CONTEXT_ID,
      })
      .transaction();
    await this.sendER(tx);
  }

  async resolveBet(
    market: MarketInfo,
    betIdx: number
  ): Promise<{ verdict: Verdict | null; ms: number }> {
    // Snapshot the bet + balance so we can infer the verdict from the on-chain
    // delta even if the ER hasn't indexed the tx logs yet.
    const before = await this.fetchUser("er");
    const bet = before?.bets[betIdx];
    const balBefore = before?.balance ?? 0;

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
    // ms = the rollup's send→confirm time for the settlement itself.
    const { sig, ms } = await this.sendER(tx);

    // Preferred: read the BetResolved event. ER log indexing can lag the
    // confirmation, so retry the fetch a few times before giving up.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const txInfo = await this.er.getTransaction(sig, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        for (const ev of this.events.parseLogs(txInfo?.meta?.logMessages ?? [])) {
          if (ev.name === "betResolved") {
            const d = ev.data as any;
            return {
              verdict: {
                outcome: outcomeLabel(d.outcome),
                stake: (d.stake as BN).toNumber(),
                payout: (d.payout as BN).toNumber(),
                marketIdx: d.marketIdx,
              },
              ms,
            };
          }
        }
        if (txInfo) break; // tx indexed but somehow no event — fall to delta
      } catch {
        /* keep retrying */
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    // Fallback: infer from the balance delta against the snapshot.
    if (bet) {
      const after = await this.fetchUser("er");
      if (after && after.bets[betIdx]?.status !== 1) {
        const delta = after.balance - balBefore;
        const outcome: Verdict["outcome"] =
          delta >= bet.stake + bet.potentialProfit
            ? "win"
            : delta <= 0
              ? "loss"
              : "push";
        return {
          verdict: {
            outcome,
            stake: bet.stake,
            payout: outcome === "win" ? bet.stake + bet.potentialProfit : delta > 0 ? delta : 0,
            marketIdx: market.idx,
          },
          ms,
        };
      }
    }
    return { verdict: null, ms };
  }

  /** Void an expired bet whose settlement window closed with no qualifying
   *  print (dead/frozen feed) — refunds the stake. Permissionless, like
   *  resolveBet; lets a user self-rescue without waiting for the house sweeper. */
  async voidBet(
    market: MarketInfo,
    betIdx: number
  ): Promise<{ verdict: Verdict | null; ms: number }> {
    const before = await this.fetchUser("er");
    const bet = before?.bets[betIdx];
    const tx = await this.program.methods
      .voidBet(betIdx)
      .accounts({
        resolver: this.wallet.publicKey,
        market: this.marketPda(market.idx),
        book: this.bookPda(market.idx),
        house: this.housePda,
        userAccount: this.userPda,
        feed: new PublicKey(market.feed),
      })
      .transaction();
    const { ms } = await this.sendER(tx);
    return {
      verdict: bet
        ? { outcome: "push", stake: bet.stake, payout: bet.stake, marketIdx: market.idx }
        : null,
      ms,
    };
  }

  async undelegateUser(): Promise<void> {
    const tx = await this.program.methods
      .undelegateUser()
      .accounts({ payer: this.wallet.publicKey, userAccount: this.userPda })
      .transaction();
    await this.sendER(tx);
  }

  // ── latency duel: the same transaction, ER vs Solana L1 ───────

  /** Send an identical memo tx to a connection, time send→confirmed.
   *  When `report` is false this is a warm-up (clones the account / primes the
   *  leader) and the timing is discarded — so the measured race is cold-start-free
   *  and fair to both layers. */
  private async raceMemo(
    conn: Connection,
    report: boolean,
    onConfirmed?: (ms: number) => void
  ): Promise<{ ms: number; sig: string }> {
    const ix = new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(`wick ${Date.now()}`),
    });
    const tx = new Transaction().add(ix);
    tx.feePayer = this.wallet.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    await this.wallet.signTransaction(tx);
    const t0 = performance.now();
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    for (;;) {
      const st = await conn.getSignatureStatus(sig);
      const c = st.value?.confirmationStatus;
      const done = c === "confirmed" || c === "finalized";
      if (done || performance.now() - t0 > 20_000) {
        const ms = Math.round(performance.now() - t0);
        if (report) onConfirmed?.(ms);
        return { ms, sig };
      }
      await new Promise((r) => setTimeout(r, 12));
    }
  }

  /** Fire the same memo on the ER and on Solana L1 at once; report each as it
   *  lands. Both lanes are warmed first so neither pays a one-time cold-start.
   *  `onStart` fires when warm-up is done and the measured race begins. */
  async latencyDuel(cb: {
    onStart?: () => void;
    onEr: (ms: number) => void;
    onL1: (ms: number) => void;
  }): Promise<{ er: number; l1: number }> {
    // warm both layers (clone the burner / prime the leader); discard timing
    await Promise.all([
      this.raceMemo(this.er, false).catch(() => null),
      this.raceMemo(this.base, false).catch(() => null),
    ]);
    cb.onStart?.();
    const [er, l1] = await Promise.all([
      this.raceMemo(this.er, true, cb.onEr),
      this.raceMemo(this.base, true, cb.onL1),
    ]);
    return { er: er.ms, l1: l1.ms };
  }
}

/** Maps the on-chain outcome byte to a verdict label. A void (3) is a stake
 *  refund — shown as a push so the UI never reports a phantom loss. */
function outcomeLabel(o: number): Verdict["outcome"] {
  return o === 1 ? "win" : o === 0 ? "loss" : "push";
}

export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);
