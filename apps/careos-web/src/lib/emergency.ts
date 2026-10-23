// The emergency card must work with NO server, NO database and NO network (principle S8), so it is static data
// compiled into the app. It prepares a call; a human places it. CareOS never calls anyone on its own.

export type Locale = "US" | "IN";

export interface EmergencyInfo {
  locale: Locale;
  number: string;
  /** Spoken/typed label for the number. */
  label: string;
  poison: { label: string; tel?: string };
  steps: string[];
}

const STEPS = [
  "Call now. Say where you are, who needs help, and what happened.",
  "Stay with the person. Keep them still and warm.",
  "Do not give food, drink or any medicine unless the dispatcher tells you to.",
  "Unlock the front door and turn on the lights so help can find you.",
  "Have ready: their age, weight, medicines taken and when, and any allergies.",
];

export const EMERGENCY: Record<Locale, EmergencyInfo> = {
  US: { locale: "US", number: "911", label: "Call 911", poison: { label: "Poison Help 1-800-222-1222", tel: "18002221222" }, steps: STEPS },
  IN: { locale: "IN", number: "112", label: "Call 112 (ambulance 108)", poison: { label: "Call your local poison information centre" }, steps: STEPS },
};

export const telHref = (number: string) => `tel:${number}`;
