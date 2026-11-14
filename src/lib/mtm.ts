/**
 * Made-to-measure settings with their defaults — the one place every screen
 * reads them from, so a shop that never opened Settings → Manufacturing still
 * gets sensible lists (and its own changes win the moment it saves).
 */
import type { Company, MtmSettings } from "@/types";

export const DEFAULT_MTM: Required<Omit<MtmSettings, "constants">> & {
  constants: NonNullable<MtmSettings["constants"]>;
} = {
  sizeUnit: "in",
  minSqft: 0,
  constants: [],
  productTypes: [
    "Easy Lift (Single Dori / Chain System)",
    "Cord Lift",
    "Roller",
    "Zebra",
    "Vertical",
    "Roman",
    "Curtain",
  ],
  operateSides: ["Left", "Right", "Centre"],
  jobStages: ["New", "Cutting", "Assembly", "Ready", "Fitted"],
  completeStage: "Ready",
  jobPrefix: "WB-",
};

export function mtmOf(company: Pick<Company, "mtm"> | undefined): typeof DEFAULT_MTM {
  const m = company?.mtm ?? {};
  const list = (v: string[] | undefined, d: string[]) => (v && v.length ? v : d);
  const stages = list(m.jobStages, DEFAULT_MTM.jobStages);
  return {
    sizeUnit: m.sizeUnit ?? DEFAULT_MTM.sizeUnit,
    minSqft: m.minSqft ?? DEFAULT_MTM.minSqft,
    constants: m.constants ?? [],
    productTypes: list(m.productTypes, DEFAULT_MTM.productTypes),
    operateSides: list(m.operateSides, DEFAULT_MTM.operateSides),
    jobStages: stages,
    // The "made" stage must be one of the stages; otherwise the last but one.
    completeStage:
      m.completeStage && stages.includes(m.completeStage)
        ? m.completeStage
        : stages[Math.max(0, stages.length - 2)],
    jobPrefix: m.jobPrefix?.trim() || DEFAULT_MTM.jobPrefix,
  };
}
