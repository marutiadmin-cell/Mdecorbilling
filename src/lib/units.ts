/**
 * Length and area units, as a shop writes them.
 *
 * A blind is measured in inches at one house and centimetres at the next; a
 * slat is bought by the foot, a bottom rail by the metre, fabric by the metre
 * and ladder tape by the metre or foot. The size formulas (lib/formula.ts)
 * work in whatever unit the order was measured in, and the answer has to land
 * in the unit the ITEM is stocked in — so every conversion goes through here,
 * never through an ad-hoc "× 0.0254" in a component.
 *
 * Item units are free text (Settings → Units), so this reads the common ways
 * of writing each one and answers null for anything that is not a length —
 * "pcs", "set", "kg" — which callers treat as "count, do not convert".
 */

export type LengthUnit = "mm" | "cm" | "in" | "ft" | "m";
export const LENGTH_UNITS: LengthUnit[] = ["in", "cm", "mm", "ft", "m"];
export const LENGTH_LABEL: Record<LengthUnit, string> = {
  in: "inch",
  cm: "cm",
  mm: "mm",
  ft: "feet",
  m: "metre",
};

const MM_PER: Record<LengthUnit, number> = { mm: 1, cm: 10, in: 25.4, ft: 304.8, m: 1000 };

const ALIASES: Record<string, LengthUnit> = {
  mm: "mm",
  millimeter: "mm",
  millimetre: "mm",
  cm: "cm",
  cms: "cm",
  centimeter: "cm",
  centimetre: "cm",
  in: "in",
  inch: "in",
  inches: "in",
  '"': "in",
  ft: "ft",
  feet: "ft",
  foot: "ft",
  "'": "ft",
  rft: "ft", // running feet
  rf: "ft",
  m: "m",
  mtr: "m",
  mtrs: "m",
  meter: "m",
  meters: "m",
  metre: "m",
  metres: "m",
  rmt: "m", // running metre
};

/** The length unit a free-text unit means, or null if it is not a length. */
export function lengthUnitOf(unit: string | undefined | null): LengthUnit | null {
  if (!unit) return null;
  const k = unit.trim().toLowerCase().replace(/\.$/, "");
  return ALIASES[k] ?? null;
}

/** Convert a length between units. */
export function convertLength(value: number, from: LengthUnit, to: LengthUnit): number {
  if (from === to) return value;
  return (value * MM_PER[from]) / MM_PER[to];
}

export type AreaUnit = "sqft" | "sqm";
const AREA_ALIASES: Record<string, AreaUnit> = {
  sqft: "sqft",
  "sq ft": "sqft",
  "sq.ft": "sqft",
  "sq.ft.": "sqft",
  sft: "sqft",
  "square feet": "sqft",
  sqm: "sqm",
  "sq m": "sqm",
  "sq.m": "sqm",
  "sq mtr": "sqm",
  "square metre": "sqm",
  "square meter": "sqm",
};
export function areaUnitOf(unit: string | undefined | null): AreaUnit | null {
  if (!unit) return null;
  return AREA_ALIASES[unit.trim().toLowerCase()] ?? null;
}
export const SQM_PER_SQFT = 0.09290304;

/**
 * Turn a formula's answer, stated in `resultUnit`, into the item's own unit.
 *
 * Lengths convert between each other, areas between each other. Anything
 * else (a count, or a unit pair that does not match) is returned as it is —
 * "3 pcs of ladder tape" stays 3 — and `converted` says so, so the BOM screen
 * can warn when a length answer lands on an item stocked in "pcs".
 */
export function toItemUnit(
  value: number,
  resultUnit: string | undefined,
  itemUnit: string | undefined,
): { value: number; converted: boolean; mismatch: boolean } {
  const rl = lengthUnitOf(resultUnit);
  const il = lengthUnitOf(itemUnit);
  if (rl && il)
    return { value: convertLength(value, rl, il), converted: rl !== il, mismatch: false };
  const ra = areaUnitOf(resultUnit);
  const ia = areaUnitOf(itemUnit);
  if (ra && ia) {
    if (ra === ia) return { value, converted: false, mismatch: false };
    const v = ra === "sqft" ? value * SQM_PER_SQFT : value / SQM_PER_SQFT;
    return { value: v, converted: true, mismatch: false };
  }
  // A length (or area) answer put on an item that is not stocked in one —
  // or the other way round — is almost always a mistake in the BOM.
  const mismatch = !!resultUnit && (!!rl || !!ra) !== (!!il || !!ia);
  return { value, converted: false, mismatch };
}
