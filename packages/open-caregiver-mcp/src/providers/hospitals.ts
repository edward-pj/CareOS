// Nearby emergency departments. The interface is what the rest of CareOS depends on; the implementation behind it is
// swappable. TODAY the only implementation is a labelled FIXTURE of made-up sample hospitals. An Amazon Location Service
// provider (place search + route calculation) belongs behind the same interface once the AWS account has access: it is NOT
// built, and nothing in CareOS claims live hospital data.

import type { LocaleCode } from "../data/locale.js";

export interface Coordinates { lat: number; lng: number; label?: string }

export interface Hospital {
  name: string;
  address: string;
  distance: number;
  distanceUnit: "mi" | "km";
  /** Estimated by the provider; never a live traffic figure unless the provider says so. */
  driveMinutes: number;
  /** "Hours as listed; call to confirm." is the honest default. CareOS never states live ER status or wait times. */
  hoursNote: string;
  phone?: string;
  /** True for fixture data, so the card can label it. */
  sample: boolean;
}

export interface HospitalProvider {
  readonly name: string;
  readonly live: boolean;
  findNearby(q: { origin: Coordinates; limit: number; locale: LocaleCode }): Promise<Hospital[]>;
}

const KM_PER_MI = 1.609344;
const haversineKm = (a: Coordinates, b: Coordinates) => {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

/** A household with no location set uses this point; the fixture hospitals sit around it. Demo values only. */
export const DEMO_ORIGIN: Coordinates = { lat: 47.6062, lng: -122.3321, label: "Demo location" };

const FIXTURE: { name: string; address: string; lat: number; lng: number; phone: string }[] = [
  { name: "Sample General Hospital (demo data)", address: "100 Example Ave", lat: 47.6101, lng: -122.3421, phone: "555-0101" },
  { name: "Sample Children's Hospital (demo data)", address: "200 Placeholder St", lat: 47.6205, lng: -122.3212, phone: "555-0102" },
  { name: "Sample Community Medical Center (demo data)", address: "300 Fixture Rd", lat: 47.5952, lng: -122.3316, phone: "555-0103" },
  { name: "Sample Regional ER (demo data)", address: "400 Mock Blvd", lat: 47.6512, lng: -122.3470, phone: "555-0104" },
];

export class FixtureHospitalProvider implements HospitalProvider {
  readonly name = "fixture";
  readonly live = false;

  async findNearby({ origin, limit, locale }: { origin: Coordinates; limit: number; locale: LocaleCode }): Promise<Hospital[]> {
    const distanceUnit = locale === "IN" ? "km" : "mi";
    return FIXTURE.map((h) => ({ h, km: haversineKm(origin, h) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, limit)
      .map(({ h, km }) => ({
        name: h.name,
        address: h.address,
        distance: Math.round((distanceUnit === "km" ? km : km / KM_PER_MI) * 10) / 10,
        distanceUnit,
        // A rough 30 km/h city average: an estimate, labelled as one on the card.
        driveMinutes: Math.max(2, Math.round((km / 30) * 60)),
        hoursNote: "Hours as listed; call to confirm.",
        phone: h.phone,
        sample: true,
      }));
  }
}
