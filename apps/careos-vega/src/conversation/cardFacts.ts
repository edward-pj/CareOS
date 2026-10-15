import type {CardType} from '../api/types';

export interface CardFacts {
  title: string;
  /** Large figure, e.g. the dose volume. */
  headline?: string;
  lines: string[];
  tone: 'ok' | 'danger';
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const compact = (xs: Array<string | undefined>): string[] => xs.filter((x): x is string => !!x);

/**
 * Turns a tool payload into display facts. Every number shown here is copied from the payload, never
 * derived, so the card cannot disagree with the deterministic engines. Phase 6 replaces the plain
 * rendering of these facts with the full card components.
 */
export function cardFacts(type: CardType, p: Record<string, unknown>): CardFacts {
  switch (type) {
    case 'SYRINGE_CALIBRATOR': {
      const ml = num(p.dispense_volume_ml);
      const mg = num(p.delivered_dose_mg);
      return {
        title: 'Dose',
        headline: ml === undefined ? undefined : `${ml} mL`,
        lines: compact([mg === undefined ? undefined : `${mg} mg delivered`, str(p.formulation_label), str(p.warning)]),
        tone: 'ok',
      };
    }
    case 'DOUBLE_DOSE_INTERCEPT': {
      const last = (p.last_dose ?? {}) as Record<string, unknown>;
      const mins = num(p.remaining_minutes);
      return {
        title: 'Dose lock',
        headline: mins === undefined ? undefined : `${mins} min`,
        lines: compact([
          str(last.caregiver) && `${str(last.caregiver)} gave ${str(last.medication) ?? 'a dose'} at ${str(last.time_label) ?? 'an earlier time'}`,
          str(p.violation_type) === 'DAILY_MAX' ? 'Daily maximum reached' : undefined,
        ]),
        tone: 'danger',
      };
    }
    case 'CONTRAINDICATION_SHIELD':
      return {
        title: 'Not safe',
        lines: compact([str(p.clinical_rationale), str(p.approved_alternative) && `Safer option: ${str(p.approved_alternative)}`]),
        tone: 'danger',
      };
    case 'PANTRY_REMEDY': {
      const steps = Array.isArray(p.preparation_steps) ? p.preparation_steps.filter((s): s is string => typeof s === 'string') : [];
      const badges = Array.isArray(p.safety_badges) ? p.safety_badges.filter((s): s is string => typeof s === 'string') : [];
      return {title: str(p.remedy_title) ?? 'Pantry remedy', lines: [...steps, ...badges], tone: 'ok'};
    }
    case 'AMAZON_RESTOCK_CAROUSEL': {
      const items = Array.isArray(p.items) ? (p.items as Array<Record<string, unknown>>) : [];
      const total = num(p.total_usd);
      return {
        title: 'Restock',
        headline: total === undefined ? undefined : `$${total.toFixed(2)}`,
        lines: compact([...items.map((i) => str(i.name)), str(p.eta) && `Arrives ${str(p.eta)}`]),
        tone: 'ok',
      };
    }
  }
}
