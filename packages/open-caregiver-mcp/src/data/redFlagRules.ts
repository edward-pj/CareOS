// Red-flag triage rules (PRD §7). The rule set is DATA, not code: each rule has an id, a plain-language trigger, an urgency level
// and a published source. Escalation is by signs and age, not temperature alone.
//
// Every source below was opened and read on 2026-10-19 (see `retrieved`). Where a rule goes beyond what its source says, the
// `note` says so plainly instead of dressing it up. This is a curated starter set for a demo, not a clinical triage tool.

export type Urgency = "CALL_EMERGENCY" | "GO_TO_ER_NOW" | "CALL_DOCTOR_TODAY" | "HOME_CARE_OK_WITH_WATCH";

/** Highest first. */
export const URGENCY_RANK: Record<Urgency, number> = { CALL_EMERGENCY: 3, GO_TO_ER_NOW: 2, CALL_DOCTOR_TODAY: 1, HOME_CARE_OK_WITH_WATCH: 0 };

/** Things a caregiver can report. Flat strings so the MCP tool schema stays a plain enum. */
export const SIGNS = [
  "difficulty_breathing",
  "blue_or_gray_color",
  "unresponsive_or_hard_to_wake",
  "very_ill_or_unusually_drowsy",
  "seizure",
  "non_fading_rash",
  "stiff_neck",
  "repeated_vomiting",
  "no_wet_diaper_8h",
  "no_tears",
  "sunken_soft_spot",
  "vomited_after_dose",
  "face_drooping",
  "arm_weakness",
  "speech_difficulty",
  "chest_pain",
  "severe_shortness_of_breath",
  "head_strike",
  "lip_or_throat_swelling",
  "wheezing",
] as const;
export type Sign = (typeof SIGNS)[number];

/** The question the Red-Flag Checklist asks for each sign. */
export const SIGN_QUESTION: Record<Sign, string> = {
  difficulty_breathing: "Is {name} having trouble breathing?",
  blue_or_gray_color: "Are {name}'s lips, tongue or skin blue or gray?",
  unresponsive_or_hard_to_wake: "Is {name} hard to wake, limp, or not responding normally?",
  very_ill_or_unusually_drowsy: "Does {name} look very ill or unusually drowsy?",
  seizure: "Has {name} had a seizure?",
  non_fading_rash: "Is there a rash that does not fade when you press a glass against it?",
  stiff_neck: "Does {name} have a stiff neck?",
  repeated_vomiting: "Has {name} been vomiting again and again?",
  no_wet_diaper_8h: "Has {name} had no wet diaper for 8 hours?",
  no_tears: "Is {name} crying without tears?",
  sunken_soft_spot: "Is the soft spot on top of {name}'s head sunken?",
  vomited_after_dose: "Did {name} throw up after the medicine?",
  face_drooping: "Is one side of {name}'s face drooping?",
  arm_weakness: "Is one of {name}'s arms weak or numb?",
  speech_difficulty: "Is {name}'s speech slurred or confused?",
  chest_pain: "Does {name} have chest pain?",
  severe_shortness_of_breath: "Is {name} severely short of breath?",
  head_strike: "Did {name} hit their head?",
  lip_or_throat_swelling: "Are {name}'s lips, mouth or throat swelling?",
  wheezing: "Is {name} wheezing?",
};

export interface RuleSource {
  /** Publisher and page, as a person would cite it. */
  name: string;
  url: string;
  /** What on that page the rule rests on. */
  section: string;
  retrieved: string;
}

export interface RedFlagRule {
  id: string;
  /** Plain-language trigger, shown on the card. */
  trigger: string;
  /** Patient age window in days (inclusive min, exclusive max). Omitted = any age. */
  minAgeDays?: number;
  maxAgeDays?: number;
  /** Fires when ANY of these signs is reported. */
  anySigns?: Sign[];
  /** Fires when the temperature is at least this (degrees F). */
  tempFAtLeast?: number;
  /** Fires when the fever has lasted more than this many days. */
  feverDaysOver?: number;
  /** Combined with `anySigns`: only fires when the person takes an anticoagulant. */
  requiresAnticoagulant?: boolean;
  urgency: Urgency;
  /** What to say (no numbers other than ones in the rule itself). */
  say: string;
  /** Never re-dose, and do not offer a dose, while this rule is active. */
  noHomeDosing?: boolean;
  source: RuleSource;
  /** Anything the rule does that its source does not literally say. */
  note?: string;
}

const R = "2026-10-19";
const AAP_WHEN: RuleSource = { name: "American Academy of Pediatrics (HealthyChildren.org): When to Call the Pediatrician about Fever", url: "https://www.healthychildren.org/English/health-issues/conditions/fever/Pages/When-to-Call-the-Pediatrician.aspx", section: "When to call", retrieved: R };
const AAP_DEHYDRATION: RuleSource = { name: "American Academy of Pediatrics (HealthyChildren.org): Dehydration", url: "https://healthychildren.org/English/health-issues/injuries-emergencies/Pages/dehydration.aspx", section: "Warning signs of dehydration", retrieved: R };
const NHS_FEVER: RuleSource = { name: "NHS: High temperature (fever) in children", url: "https://www.nhs.uk/conditions/fever-in-children/", section: "Call 999 / Call 111", retrieved: R };
const NHS_ANAPHYLAXIS: RuleSource = { name: "NHS: Anaphylaxis", url: "https://www.nhs.uk/conditions/anaphylaxis/", section: "Symptoms; when to call 999", retrieved: R };
const CDC_STROKE: RuleSource = { name: "CDC: Signs and Symptoms of Stroke", url: "https://www.cdc.gov/stroke/signs-symptoms/index.html", section: "F.A.S.T.", retrieved: R };
const NHS_HEART: RuleSource = { name: "NHS: Heart attack symptoms", url: "https://www.nhs.uk/conditions/heart-attack/symptoms/", section: "Chest pain, shortness of breath; call 999", retrieved: R };
const NHS_HEAD: RuleSource = { name: "NHS: Head injury and concussion", url: "https://www.nhs.uk/conditions/head-injury-and-concussion/", section: "Blood-thinning medicine: get urgent advice", retrieved: R };
const WA_HEAD: RuleSource = { name: "Washington State Department of Health: Head Injury in Anticoagulated Patients guideline (2024)", url: "https://www.doh.wa.gov/sites/default/files/2024-12/689-160-HeadInjuryAnticoagulatedPatientsGuideline.pdf", section: "Adults on anticoagulants with a head-injury mechanism", retrieved: R };

const THREE_MONTHS_DAYS = 84; // 12 weeks, as the AAP page states it
const TWO_YEARS_DAYS = 730;
const CHILD_MAX_DAYS = 18 * 365;

export const RED_FLAG_RULES: RedFlagRule[] = [
  {
    id: "RF-INFANT-FEVER-U3M",
    trigger: "Under 3 months old with a temperature of 100.4°F (38.0°C) or higher",
    maxAgeDays: THREE_MONTHS_DAYS,
    tempFAtLeast: 100.4,
    urgency: "GO_TO_ER_NOW",
    say: "A baby this young with a fever needs to be seen right away. Call your pediatrician or go to urgent care now, and don't give fever medicine first.",
    noHomeDosing: true,
    source: AAP_WHEN,
    note: "The AAP page says call the doctor right away; CareOS raises it to 'be seen now' and withholds home dosing, as the PRD specifies (C9).",
  },
  { id: "RF-ANY-BREATHING", trigger: "Difficulty breathing", anySigns: ["difficulty_breathing"], urgency: "CALL_EMERGENCY", say: "Trouble breathing is an emergency.", source: NHS_FEVER },
  { id: "RF-ANY-BLUE-GRAY", trigger: "Blue or gray lips, tongue or skin", anySigns: ["blue_or_gray_color"], urgency: "CALL_EMERGENCY", say: "Blue or gray skin or lips is an emergency.", source: NHS_ANAPHYLAXIS, note: "The NHS lists blue or grey skin, lips or tongue among its 999 signs on the anaphylaxis page; the rule applies it to any cause." },
  { id: "RF-ANY-UNRESPONSIVE", trigger: "Very hard to wake, limp or not responding", anySigns: ["unresponsive_or_hard_to_wake"], urgency: "CALL_EMERGENCY", say: "Someone who is hard to wake or not responding needs emergency help.", source: NHS_FEVER },
  { id: "RF-ANY-SEIZURE", trigger: "Seizure (fit)", anySigns: ["seizure"], urgency: "CALL_EMERGENCY", say: "A seizure is an emergency.", source: NHS_FEVER },
  { id: "RF-ANY-NON-FADING-RASH", trigger: "A rash that does not fade when pressed with a glass", anySigns: ["non_fading_rash"], urgency: "CALL_EMERGENCY", say: "A rash that doesn't fade under a glass is an emergency.", source: NHS_FEVER },
  { id: "RF-ANY-STIFF-NECK", trigger: "Stiff neck", anySigns: ["stiff_neck"], urgency: "CALL_EMERGENCY", say: "A stiff neck with illness is an emergency.", source: NHS_FEVER },
  { id: "RF-ANY-DROWSY", trigger: "Looks very ill or is unusually drowsy", anySigns: ["very_ill_or_unusually_drowsy"], urgency: "CALL_DOCTOR_TODAY", say: "Call your doctor or nurse line right away.", noHomeDosing: false, source: AAP_WHEN },
  { id: "RF-ANY-VOMITING", trigger: "Vomiting repeatedly", anySigns: ["repeated_vomiting"], urgency: "CALL_DOCTOR_TODAY", say: "Call your doctor or nurse line right away.", source: AAP_WHEN },
  {
    id: "RF-CHILD-DEHYDRATION",
    trigger: "Signs of dehydration in a baby or young child: no wet diaper for 8 hours, no tears, or a sunken soft spot",
    maxAgeDays: 3 * 365,
    anySigns: ["no_wet_diaper_8h", "no_tears", "sunken_soft_spot"],
    urgency: "CALL_DOCTOR_TODAY",
    say: "These can be signs of dehydration. Call your pediatrician or nurse line right away.",
    source: AAP_DEHYDRATION,
    note: "The AAP page lists fewer tears, a sunken soft spot and fewer wet diapers (for infants, fewer than six a day) as warning signs and says to tell the pediatrician immediately. It does NOT state an 8-hour threshold: that figure is the PRD's and should be confirmed by a clinician.",
  },
  {
    id: "RF-DOSE-VOMITED",
    trigger: "Threw up after the medicine",
    anySigns: ["vomited_after_dose"],
    urgency: "CALL_DOCTOR_TODAY",
    say: "Don't give another dose. Call your nurse line or pediatrician and ask what to do.",
    noHomeDosing: true,
    source: { name: "CareOS policy (PRD C10); no published re-dose rule", url: "https://dailymed.nlm.nih.gov/", section: "Medicine labels give no instruction for a vomited dose", retrieved: R },
    note: "No guideline read for this project gives a rule for a vomited dose, so CareOS does not guess one: it blocks re-dosing and refers to a clinician.",
  },
  {
    id: "RF-FEVER-DAYS-UNDER-2Y",
    trigger: "Fever lasting more than 24 hours in a child under 2 years",
    minAgeDays: THREE_MONTHS_DAYS,
    maxAgeDays: TWO_YEARS_DAYS,
    feverDaysOver: 1,
    urgency: "CALL_DOCTOR_TODAY",
    say: "A fever that has lasted this long should be checked. Call your pediatrician today.",
    source: AAP_WHEN,
  },
  {
    id: "RF-FEVER-DAYS-2Y-PLUS",
    trigger: "Fever lasting more than 3 days in a child 2 years or older",
    minAgeDays: TWO_YEARS_DAYS,
    maxAgeDays: CHILD_MAX_DAYS,
    feverDaysOver: 3,
    urgency: "CALL_DOCTOR_TODAY",
    say: "A fever that has lasted this long should be checked. Call your pediatrician today.",
    source: AAP_WHEN,
  },
  {
    id: "RF-CHILD-TEMP-104",
    trigger: "Temperature of 104°F (40°C) or higher in a child",
    minAgeDays: THREE_MONTHS_DAYS,
    maxAgeDays: CHILD_MAX_DAYS,
    tempFAtLeast: 104,
    urgency: "CALL_DOCTOR_TODAY",
    say: "A temperature this high is a reason to call your pediatrician now. How your child is acting matters most.",
    source: AAP_WHEN,
    note: "The AAP page says a temperature REPEATEDLY above 104°F; CareOS acts on a single reading and lets the caregiver's signs decide the urgency.",
  },
  { id: "RF-STROKE-FAST", trigger: "Stroke signs: face drooping, arm weakness or speech difficulty", anySigns: ["face_drooping", "arm_weakness", "speech_difficulty"], urgency: "CALL_EMERGENCY", say: "These can be signs of a stroke. Note the time they started.", source: CDC_STROKE },
  { id: "RF-CHEST-BREATH", trigger: "Chest pain or severe shortness of breath", anySigns: ["chest_pain", "severe_shortness_of_breath"], urgency: "CALL_EMERGENCY", say: "Chest pain or severe breathlessness is an emergency.", source: NHS_HEART },
  { id: "RF-ANAPHYLAXIS", trigger: "Swelling of the lips, mouth or throat, or wheezing after a possible allergen", anySigns: ["lip_or_throat_swelling", "wheezing"], urgency: "CALL_EMERGENCY", say: "This can be a severe allergic reaction.", source: NHS_ANAPHYLAXIS, note: "Wheezing alone is not always an allergy; CareOS treats it as an emergency sign because the NHS lists it among anaphylaxis symptoms." },
  {
    id: "RF-HEAD-ANTICOAGULANT",
    trigger: "Hit their head while taking a blood thinner",
    anySigns: ["head_strike"],
    requiresAnticoagulant: true,
    minAgeDays: CHILD_MAX_DAYS,
    urgency: "GO_TO_ER_NOW",
    say: "A knock to the head on a blood thinner needs to be checked urgently, even if he feels fine.",
    source: WA_HEAD,
    note: "Also: the NHS head-injury page says to get urgent advice when someone takes blood-thinning medicine. Evidence on routine scanning is debated, so CareOS says 'be checked', not 'you need a scan'.",
  },
];

/** Cited sources, for the Data Inspector and docs. */
export const RED_FLAG_SOURCES = [...new Map(RED_FLAG_RULES.map((r) => [r.source.url, r.source])).values()];
export { NHS_HEAD as HEAD_INJURY_SECOND_SOURCE };

/** Signs worth asking about for a person of this age, most urgent first. */
export function checklistFor(ageDays: number, onAnticoagulant: boolean): Sign[] {
  const out = new Set<Sign>();
  for (const r of RED_FLAG_RULES) {
    if ((r.minAgeDays ?? 0) > ageDays || ageDays >= (r.maxAgeDays ?? Infinity)) continue;
    if (r.requiresAnticoagulant && !onAnticoagulant) continue;
    for (const s of r.anySigns ?? []) if (s !== "vomited_after_dose") out.add(s);
  }
  return [...out];
}
