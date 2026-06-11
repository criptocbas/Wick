import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

/** Minimal anchor-compatible wallet around a browser-held keypair. */
export class KeypairWallet {
  constructor(readonly payer: Keypair) {}

  get publicKey(): PublicKey {
    return this.payer.publicKey;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof Transaction) tx.partialSign(this.payer);
    else (tx as VersionedTransaction).sign([this.payer]);
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    for (const tx of txs) await this.signTransaction(tx);
    return txs;
  }
}

const STORAGE_KEY = "wick:burner";

/** The burner doubles as the session key: zero popups, fully gasless on the ER. */
export function loadBurner(): Keypair {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  const kp = Keypair.generate();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}
