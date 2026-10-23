import type { Caregiver, PatientSnapshot } from "../api/types";

/** Preset prompts. They use the active profile's own data so they stay valid when the seed changes. */
export function presets(patient: PatientSnapshot | undefined, caregivers: Caregiver[], caregiver: string): string[] {
  const name = patient?.profile.name ?? "Leo";
  const isElder = patient?.profile.kind === "elder";
  const weight = patient?.profile.weightLbs;
  const other = caregivers.find((c) => c.name !== caregiver)?.name;
  return [
    isElder ? "Can Frank take Advil?" : weight ? `${name} has a fever and weighs ${weight} lbs. How much Motrin?` : `${name} has a fever. How much Motrin?`,
    `I gave ${name} Motrin`,
    isElder ? "What did the doctor say last time about Frank's gout?" : `${name}'s temperature is 101.4`,
    "Can Frank take NyQuil?",
    `${name} has a sore throat`,
    "Restock Motrin",
    isElder ? "Dad fell and hit his head" : `${name} threw up the dose of medicine`,
    "Help me call the nurse line",
    ...(other ? [`Switch caregiver shift to ${other}`] : []),
  ];
}
