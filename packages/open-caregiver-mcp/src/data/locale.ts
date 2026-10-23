// Locale profile (PRD §7.4). The demo default is US. These are the numbers a caregiver is told to call.

export type LocaleCode = "US" | "IN";

export interface LocaleProfile {
  code: LocaleCode;
  country: string;
  emergencyNumber: string;
  /** Spoken digit by digit-friendly form, e.g. "9 1 1" is NOT used: speech engines say "nine one one" for 911 already. */
  emergencySpoken: string;
  ambulanceNumber?: string;
  poison: { label: string; number?: string; note?: string };
  units: { weight: "lb" | "kg"; temperature: "F" | "C"; distance: "mi" | "km" };
}

export const LOCALES: Record<LocaleCode, LocaleProfile> = {
  US: {
    code: "US",
    country: "United States",
    emergencyNumber: "911",
    emergencySpoken: "9 1 1",
    poison: { label: "Poison Control", number: "1-800-222-1222" },
    units: { weight: "lb", temperature: "F", distance: "mi" },
  },
  IN: {
    code: "IN",
    country: "India",
    emergencyNumber: "112",
    emergencySpoken: "1 1 2",
    ambulanceNumber: "108",
    poison: { label: "Local poison information centre", note: "Not configured. Set the number for your area." },
    units: { weight: "kg", temperature: "C", distance: "km" },
  },
};

export function localeFor(code: string | undefined): LocaleProfile {
  return LOCALES[(code ?? "US").toUpperCase() as LocaleCode] ?? LOCALES.US;
}
