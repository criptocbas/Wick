import { toUi } from "./chain/config";

/** MagicBlock's oracle stores the exponent as a positive magnitude (8 ⇒ ×10⁻⁸);
 *  WickFeeds store it signed (−8). Normalize: positive exponents are decimals. */
export function applyExpo(raw: number, expo: number): number {
  return raw * 10 ** (expo > 0 ? -expo : expo);
}

export function fmtMoney(units: number): string {
  return toUi(units).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function fmtPrice(p: number, decimals: number): string {
  return p.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Splits a formatted price into integer and fraction for typographic styling. */
export function splitPrice(p: number, decimals: number): [string, string] {
  const s = fmtPrice(p, decimals);
  const i = s.lastIndexOf(".");
  return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i)];
}
