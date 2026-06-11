import { toUi } from "./chain/config";

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
