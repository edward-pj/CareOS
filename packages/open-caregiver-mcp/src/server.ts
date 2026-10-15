import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toFhirAdministration, toFhirMedicationStatements, toFhirPatient } from "./schemas/fhir.js";
import { CareService, type Payload } from "./service.js";

export * from "./engines/index.js";
export { CareService } from "./service.js";
export type { Payload, CardType } from "./service.js";
export * from "./storage/types.js";
export { MemoryAdapter, MemoryNotifier } from "./storage/memoryAdapter.js";
export { createSeed } from "./storage/seed.js";

// Schemas stay flat (primitives, enums, one array of flat objects): no $defs/anyOf,
// so they pass strict-schema validators such as Amazon Bedrock tool config as-is.
const channel = z.enum(["prime", "pharmacy", "fresh"]);

const result = (payload: Payload) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  structuredContent: payload as Record<string, unknown>,
  isError: false,
});
const failure = (e: unknown) => ({
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});
const guard = <A>(fn: (a: A) => Promise<Payload>) => async (a: A) => {
  try { return result(await fn(a)); } catch (e) { return failure(e); }
};

export function createCareMcpServer(service: CareService): McpServer {
  const server = new McpServer({ name: "open-caregiver-mcp", version: "0.1.0" });

  server.registerTool(
    "calculate_pediatric_dose",
    {
      title: "Calculate pediatric dose",
      description: "Deterministic weight-based infant dose, rounded DOWN to the nearest 0.25 mL syringe mark. Also refuses if the dose is locked, unsafe or age-gated. Never compute doses yourself; speak these numbers verbatim.",
      inputSchema: {
        patient_id: z.string().describe("e.g. infant_leo"),
        weight_value: z.number().describe("Weight as spoken by the caregiver"),
        weight_unit: z.enum(["lbs", "kg"]),
        medication: z.string().describe("ibuprofen, acetaminophen or a brand like Motrin"),
        formulation: z.enum(["infant_drops", "children_susp", "infant_susp"]),
        has_fever: z.boolean().optional(),
      },
    },
    guard((a) => service.calculatePediatricDose(a)),
  );

  server.registerTool(
    "verify_medication_safety",
    {
      title: "Verify medication safety",
      description: "Checks interval locks, daily caps, age gates, allergies and drug-drug contraindications. Call before any administration. Set administration_intent=true when someone is about to give it.",
      inputSchema: {
        patient_id: z.string(),
        proposed_medication: z.string(),
        administration_intent: z.boolean(),
      },
    },
    guard((a) => service.verifyMedicationSafety(a)),
  );

  server.registerTool(
    "log_administration_event",
    {
      title: "Log administration event",
      description: "Atomically records a given dose, resets the lock, decrements the bottle and alerts caregivers. Re-runs safety checks server-side. Use a stable idempotency_key per physical dose.",
      inputSchema: {
        patient_id: z.string(),
        caregiver_name: z.string(),
        medication: z.string(),
        volume_ml: z.number(),
        temperature_f: z.number().optional(),
        idempotency_key: z.string().optional(),
      },
    },
    guard((a) => service.logAdministrationEvent(a)),
  );

  server.registerTool(
    "query_pantry_remedies",
    {
      title: "Query pantry remedies",
      description: "Matches a mild symptom to ingredients in the house while enforcing the patient's medication and condition restrictions.",
      inputSchema: {
        patient_id: z.string(),
        symptom: z.enum(["sore_throat", "cough", "nausea", "cold"]),
      },
    },
    guard((a) => service.queryPantryRemedies(a)),
  );

  server.registerTool(
    "stage_amazon_cart",
    {
      title: "Stage Amazon cart",
      description: "Bundles depleted medical and pantry items into a simulated Amazon cart. Does not place the order.",
      inputSchema: {
        requested_items: z.array(z.object({ item_name: z.string(), channel })),
      },
    },
    guard((a) => service.stageAmazonCart(a)),
  );

  server.registerTool(
    "confirm_amazon_order",
    {
      title: "Confirm Amazon order",
      description: "Places a staged cart (simulated). Only call after the caregiver explicitly confirms.",
      inputSchema: { cart_id: z.string() },
    },
    guard((a) => service.confirmAmazonOrder(a)),
  );

  server.registerTool(
    "override_lockout",
    {
      title: "Override interval lock",
      description: "Emergency override of an interval lock (not contraindications or daily caps). Requires the caregiver's 4-digit PIN.",
      inputSchema: {
        patient_id: z.string(),
        ingredient: z.string(),
        caregiver: z.string(),
        pin: z.string().regex(/^\d{4}$/),
      },
    },
    guard((a) => service.overrideLockout(a)),
  );

  const json = (uri: URL, data: unknown) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }] });

  for (const id of ["leo", "frank"]) {
    server.registerResource(
      `patient_${id}`,
      `careos://patients/${id}`,
      { title: `Patient profile: ${id}`, description: "Live profile, medication history, active time-locks, plus FHIR resources.", mimeType: "application/json" },
      async (uri) => {
        const snap = await service.patientSnapshot(id);
        const p = await service.patient(id);
        return json(uri, { ...snap, fhir: { patient: toFhirPatient(p), medicationStatements: toFhirMedicationStatements(p), administrations: snap.medication_history.map(toFhirAdministration) } });
      },
    );
  }

  server.registerResource(
    "household_inventory",
    "careos://household/inventory",
    { title: "Household inventory", description: "Stock levels of medications, test strips and pantry staples.", mimeType: "application/json" },
    async (uri) => json(uri, await service.storage.getInventory()),
  );

  server.registerResource(
    "patient_ledger",
    new ResourceTemplate("careos://patients/{id}/ledger", { list: undefined }),
    { title: "Administration ledger", description: "All logged doses for a patient.", mimeType: "application/json" },
    async (uri, { id }) => json(uri, await service.storage.getLedger(String(id))),
  );

  return server;
}
