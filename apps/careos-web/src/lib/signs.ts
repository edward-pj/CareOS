// Plain phrases for the warning signs the server's checklist asks about. A tap on the Red-Flag Checklist is sent as an
// ordinary sentence, so it goes through the same path as speech and the tool, not this file, decides the urgency.

export const SIGN_PHRASE: Record<string, string> = {
  difficulty_breathing: "trouble breathing",
  blue_or_gray_color: "blue lips",
  unresponsive_or_hard_to_wake: "hard to wake",
  very_ill_or_unusually_drowsy: "very sick and unusually sleepy",
  seizure: "a seizure",
  non_fading_rash: "a rash that doesn't fade under a glass",
  stiff_neck: "a stiff neck",
  repeated_vomiting: "keeps vomiting",
  no_wet_diaper_8h: "no wet diaper for 8 hours",
  no_tears: "no tears",
  sunken_soft_spot: "a sunken soft spot",
  vomited_after_dose: "threw up the dose of medicine",
  face_drooping: "face drooping",
  arm_weakness: "arm weakness",
  speech_difficulty: "slurred speech",
  chest_pain: "chest pain",
  severe_shortness_of_breath: "severe shortness of breath",
  head_strike: "hit their head",
  lip_or_throat_swelling: "swelling of the lips and throat",
  wheezing: "wheezing",
};

export function signsMessage(name: string, signs: string[]): string {
  return signs.length === 0 ? `None of those for ${name}` : `${name} has ${signs.map((s) => SIGN_PHRASE[s] ?? s.replace(/_/g, " ")).join(" and ")}`;
}
