// Minimal FHIR R4-shaped mappers so any FHIR-aware client can consume CareOS data.
import type { DoseEvent, Patient } from "../storage/types.js";

export function toFhirPatient(p: Patient) {
  return {
    resourceType: "Patient" as const,
    id: p.id,
    name: [{ text: p.name }],
    birthDate: new Date(p.dobMs).toISOString().slice(0, 10),
  };
}

export function toFhirMedicationStatements(p: Patient) {
  return p.activeRx.map((rx) => ({
    resourceType: "MedicationStatement" as const,
    status: "active",
    subject: { reference: `Patient/${p.id}` },
    medicationCodeableConcept: { text: rx },
  }));
}

export function toFhirAdministration(e: DoseEvent) {
  return {
    resourceType: "MedicationAdministration" as const,
    id: e.eventId,
    status: "completed",
    subject: { reference: `Patient/${e.patientId}` },
    medicationCodeableConcept: { text: e.medication },
    effectiveDateTime: new Date(e.at).toISOString(),
    performer: [{ actor: { display: e.caregiver } }],
    dosage: e.volumeMl === undefined ? undefined : { dose: { value: e.volumeMl, unit: "mL" } },
  };
}
