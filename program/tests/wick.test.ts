import * as anchor from "@coral-xyz/anchor";
import { Program, web3 } from "@coral-xyz/anchor";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import { Wick } from "../target/types/wick";

/**
 * Full lifecycle test against the local two-layer stack:
 *   base layer: mb-test-validator           (:8899 / :8900)
 *   rollup:     ephemeral-validator          (:7799 / :7800)
 * See README for the exact launch commands.
 */

const LOCALNET_VALIDATOR_ID = new web3.PublicKey(
  "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"
);

const FEED_KIND_WICK = 1;
const DIRECTION_UP = 1;
const EXPO = -8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function symbolBytes(s: string): number[] {
  const out = new Array(12).fill(0);
  Buffer.from(s).forEach((b, i) => {
    if (i < 12) out[i] = b;
  });
  return out;
}

const toUnits = (n: number) => new anchor.BN(Math.round(n * 1_000_000));
const px = (p: number) => new anchor.BN(Math.round(p * 1e8)); // expo -8

describe("wick lifecycle", () => {
  const provider = new anchor.AnchorProvider(
    new web3.Connection(
      process.env.PROVIDER_ENDPOINT || "http://localhost:8899",
      { commitment: "confirmed" }
    ),
    anchor.Wallet.local(),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const providerER = new anchor.AnchorProvider(
    new web3.Connection(
      process.env.EPHEMERAL_PROVIDER_ENDPOINT || "http://localhost:7799",
      {
        wsEndpoint: process.env.EPHEMERAL_WS_ENDPOINT || "ws://localhost:7800",
        commitment: "confirmed",
      }
    ),
    anchor.Wallet.local(),
    { commitment: "confirmed" }
  );

  const program = anchor.workspace.Wick as Program<Wick>;
  const admin = provider.wallet as anchor.Wallet;
  const SYMBOL = symbolBytes("SOL");

  let mint: web3.PublicKey;
  let adminAta: web3.PublicKey;

  const [configPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const [housePda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("house")],
    program.programId
  );
  const [feedPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("feed"), Buffer.from(symbolBytes("SOL"))],
    program.programId
  );
  const [marketPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("market"), Buffer.from([0])],
    program.programId
  );
  const [bookPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("book"), Buffer.from([0])],
    program.programId
  );
  const [userPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("user"), admin.publicKey.toBuffer()],
    program.programId
  );

  /** Sends a tx to the ER, re-signed with the ER blockhash + ER fee payer. */
  async function sendER(tx: web3.Transaction): Promise<string> {
    tx.feePayer = providerER.wallet.publicKey;
    const { blockhash, lastValidBlockHeight } =
      await providerER.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx = await providerER.wallet.signTransaction(tx);
    const sig = await providerER.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
    });
    const conf = await providerER.connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed"
    );
    if (conf.value.err) {
      const txInfo = await providerER.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      throw new Error(
        `ER tx ${sig} failed: ${JSON.stringify(conf.value.err)}\n` +
          (txInfo?.meta?.logMessages ?? []).join("\n")
      );
    }
    return sig;
  }

  async function pushPriceER(price: anchor.BN) {
    const tx = await program.methods
      .pushPrice(SYMBOL, price, EXPO, new anchor.BN(Date.now()))
      .accounts({
        authority: admin.publicKey,
        feed: feedPda,
      })
      .transaction();
    await sendER(tx);
  }

  /** Asserts an instruction fails with the given Anchor error code. The ER's
   *  getTransaction can race the log fetch, so match the numeric code too
   *  (looked up from the on-disk IDL — the runtime copy renames things). */
  const idlErrors: { code: number; name: string }[] = JSON.parse(
    require("node:fs").readFileSync(`${__dirname}/../target/idl/wick.json`, "utf8")
  ).errors;
  async function expectError(p: Promise<unknown>, code: string) {
    const num = idlErrors.find((e) => e.name === code)?.code;
    try {
      await p;
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      assert.isTrue(
        msg.includes(code) || (num != null && msg.includes(`"Custom":${num}`)),
        `expected ${code} (${num}), got: ${msg.slice(0, 300)}`
      );
      return;
    }
    assert.fail(`expected ${code} but the instruction succeeded`);
  }

  function placeBetTx(stakeUi: number, durationS: number) {
    return program.methods
      .placeBet(DIRECTION_UP, toUnits(stakeUi), durationS)
      .accounts({
        operator: admin.publicKey,
        market: marketPda,
        book: bookPda,
        house: housePda,
        userAccount: userPda,
        feed: feedPda,
      })
      .transaction();
  }

  function resolveBetTx(betIdx: number) {
    return program.methods
      .resolveBet(betIdx)
      .accounts({
        resolver: admin.publicKey,
        market: marketPda,
        book: bookPda,
        house: housePda,
        userAccount: userPda,
        feed: feedPda,
      })
      .transaction();
  }

  function voidBetTx(betIdx: number) {
    return program.methods
      .voidBet(betIdx)
      .accounts({
        resolver: admin.publicKey,
        market: marketPda,
        book: bookPda,
        house: housePda,
        userAccount: userPda,
        feed: feedPda,
      })
      .transaction();
  }

  async function fetchUserER() {
    const info = await providerER.connection.getAccountInfo(userPda);
    return program.coder.accounts.decode("userAccount", info!.data);
  }

  it("initializes the protocol on L1", async () => {
    mint = await createMint(
      provider.connection,
      admin.payer,
      admin.publicKey,
      null,
      6
    );
    adminAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        admin.payer,
        mint,
        admin.publicKey
      )
    ).address;
    await mintTo(
      provider.connection,
      admin.payer,
      mint,
      adminAta,
      admin.publicKey,
      100_000_000_000 // 100k wUSDC
    );

    // Localnet has no kind-0 (Pyth Lazer) markets; default disables the owner check.
    await program.methods
      .initialize(admin.publicKey, web3.PublicKey.default)
      .accounts({ admin: admin.publicKey, mint })
      .rpc();

    await program.methods
      .createFeed(SYMBOL)
      .accounts({ admin: admin.publicKey })
      .rpc();

    // Seed a first price on L1 so placement staleness checks pass post-delegation.
    await program.methods
      .pushPrice(SYMBOL, px(150), EXPO, new anchor.BN(Date.now()))
      .accounts({ authority: admin.publicKey, feed: feedPda })
      .rpc();

    await program.methods
      .createMarket(0, SYMBOL, FEED_KIND_WICK, feedPda)
      .accounts({ admin: admin.publicKey, market: marketPda, book: bookPda })
      .rpc();

    await program.methods
      .fundHouse(toUnits(50_000))
      .accounts({ admin: admin.publicKey, from: adminAta })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.equal(config.numMarkets, 1);
    const house = await program.account.house.fetch(housePda);
    assert.equal(house.balance.toString(), toUnits(50_000).toString());
  });

  it("validates and applies protocol params on L1", async () => {
    // feed-age must stay strictly below the shortest duration
    await expectError(
      program.methods
        .setParams(19_000, toUnits(0.1), toUnits(1_000), 5, 300, 6_000, 3_000, false)
        .accounts({ admin: admin.publicKey })
        .rpc(),
      "InvalidParams"
    );
    // payout at/below 1x would underflow the profit math
    await expectError(
      program.methods
        .setParams(10_000, toUnits(0.1), toUnits(1_000), 5, 300, 2_500, 3_000, false)
        .accounts({ admin: admin.publicKey })
        .rpc(),
      "InvalidParams"
    );
    // a valid update sticks (same values the protocol initializes with)
    await program.methods
      .setParams(19_000, toUnits(0.1), toUnits(1_000), 5, 300, 2_500, 3_000, false)
      .accounts({ admin: admin.publicKey })
      .rpc();
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.maxFeedAgeMs, 2_500);
    assert.equal(cfg.resolveGraceMs, 3_000);
    assert.isFalse(cfg.paused);

    // markets can be delisted and re-enabled (market PDA depends on the idx
    // arg, which anchor 0.32 can't auto-resolve — pass it explicitly)
    await program.methods
      .setMarketEnabled(0, false)
      .accounts({ admin: admin.publicKey, market: marketPda })
      .rpc();
    let mkt = await program.account.marketConfig.fetch(marketPda);
    assert.isFalse(mkt.enabled);
    await program.methods
      .setMarketEnabled(0, true)
      .accounts({ admin: admin.publicKey, market: marketPda })
      .rpc();
    mkt = await program.account.marketConfig.fetch(marketPda);
    assert.isTrue(mkt.enabled);
  });

  it("creates a user and deposits", async () => {
    await program.methods
      .initUser(web3.PublicKey.default)
      .accounts({ authority: admin.publicKey })
      .rpc();

    await program.methods
      .deposit(toUnits(1_000))
      .accounts({ authority: admin.publicKey, from: adminAta })
      .rpc();

    const user = await program.account.userAccount.fetch(userPda);
    assert.equal(user.balance.toString(), toUnits(1_000).toString());
  });

  it("delegates protocol + user accounts into the ER", async () => {
    const validator = {
      pubkey: LOCALNET_VALIDATOR_ID,
      isSigner: false,
      isWritable: false,
    };

    for (const builder of [
      program.methods
        .delegateHouse()
        .accounts({ payer: admin.publicKey, house: housePda }),
      program.methods
        .delegateBook(0)
        .accounts({ payer: admin.publicKey, book: bookPda }),
      program.methods
        .delegateFeed(SYMBOL)
        .accounts({ payer: admin.publicKey, feed: feedPda }),
      program.methods
        .delegateUser()
        .accounts({ payer: admin.publicKey, userAccount: userPda }),
    ]) {
      const tx = await builder.remainingAccounts([validator]).transaction();
      await provider.sendAndConfirm(tx, [admin.payer], {
        skipPreflight: true,
      });
    }
    await sleep(3000);
  });

  it("places and resolves a winning bet on the ER", async () => {
    await pushPriceER(px(150));

    const placeTx = await program.methods
      .placeBet(DIRECTION_UP, toUnits(10), 5)
      .accounts({
        operator: admin.publicKey,
        market: marketPda,
        book: bookPda,
        house: housePda,
        userAccount: userPda,
        feed: feedPda,
      })
      .transaction();
    const t0 = Date.now();
    await sendER(placeTx);
    console.log(`    place_bet confirmed in ${Date.now() - t0}ms on the ER`);

    // Wait out the 5s expiry, then push a higher settle print (long wins).
    await sleep(5500);
    await pushPriceER(px(151));

    const resolveTx = await program.methods
      .resolveBet(0)
      .accounts({
        resolver: admin.publicKey,
        market: marketPda,
        book: bookPda,
        house: housePda,
        userAccount: userPda,
        feed: feedPda,
      })
      .transaction();
    await sendER(resolveTx);

    const info = await providerER.connection.getAccountInfo(userPda);
    const user = program.coder.accounts.decode("userAccount", info!.data);
    // 1000 - 10 + 19 = 1009
    assert.equal(user.balance.toString(), toUnits(1_009).toString());
    assert.equal(user.wins, 1);
    assert.equal(user.openBets, 0);
  });

  it("rejects placement against a stale print", async () => {
    // Last print is now >2.5s old (max_feed_age_ms); a bet against it could be
    // struck on a price the trader already watched move.
    await sleep(3_000);
    await expectError(sendER(await placeBetTx(10, 5)), "StaleFeed");
  });

  it("voids a bet when the settlement window closes with no qualifying print", async () => {
    await pushPriceER(px(150));
    await sendER(await placeBetTx(10, 5));
    let user = await fetchUserER();
    assert.equal(user.openBets, 1);

    // The window hasn't closed yet — voiding must be rejected.
    await expectError(sendER(await voidBetTx(0)), "BetNotVoidable");

    // Dead feed: no prints for expiry(5s) + grace(3s) + void delay(2s).
    await sleep(10_500);

    // Still no post-expiry print, so resolution is impossible...
    await expectError(sendER(await resolveBetTx(0)), "NotExpired");

    // ...and a print that finally lands PAST the window can't settle either —
    // nobody gets to cherry-pick a late price.
    await pushPriceER(px(152));
    await expectError(sendER(await resolveBetTx(0)), "SettlementWindowMissed");

    // Voiding refunds the stake and frees the slot.
    await sendER(await voidBetTx(0));
    user = await fetchUserER();
    assert.equal(user.balance.toString(), toUnits(1_009).toString());
    assert.equal(user.openBets, 0);
    assert.equal(user.pushes, 1);

    const houseInfo = await providerER.connection.getAccountInfo(housePda);
    const house = program.coder.accounts.decode("house", houseInfo!.data);
    assert.equal(house.locked.toNumber(), 0);
  });

  it("undelegates and withdraws on L1", async () => {
    const undelegateTx = await program.methods
      .undelegateUser()
      .accounts({ payer: admin.publicKey, userAccount: userPda })
      .transaction();
    await sendER(undelegateTx);
    await sleep(3000);

    await program.methods
      .withdraw(toUnits(1_009))
      .accounts({ authority: admin.publicKey, to: adminAta })
      .rpc();

    const user = await program.account.userAccount.fetch(userPda);
    assert.equal(user.balance.toNumber(), 0);
  });
});
