import {describe, expect, it} from 'vitest';
import {cardFacts} from '../src/conversation/cardFacts';

describe('cardFacts', () => {
  it('copies dose numbers from the payload without deriving any', () => {
    const f = cardFacts('SYRINGE_CALIBRATOR', {dispense_volume_ml: 2, delivered_dose_mg: 80, formulation_label: 'Infant Motrin Drops (50mg/1.25mL)', warning: 'Do not use Children\'s suspension.'});
    expect(f).toMatchObject({title: 'Dose', headline: '2 mL', tone: 'ok'});
    expect(f.lines).toEqual(['80 mg delivered', 'Infant Motrin Drops (50mg/1.25mL)', "Do not use Children's suspension."]);
  });

  it('shows who dosed and how long to wait on a lock', () => {
    const f = cardFacts('DOUBLE_DOSE_INTERCEPT', {violation_type: 'DOUBLE_DOSE_LOCKED', remaining_minutes: 328, last_dose: {caregiver: 'Sarah (Mom)', medication: 'Infant Motrin Drops', time_label: '11:04 PM'}});
    expect(f).toMatchObject({title: 'Dose lock', headline: '328 min', tone: 'danger'});
    expect(f.lines[0]).toBe('Sarah (Mom) gave Infant Motrin Drops at 11:04 PM');
  });

  it('shows the rationale and the approved alternative on a contraindication', () => {
    const f = cardFacts('CONTRAINDICATION_SHIELD', {clinical_rationale: 'GI bleed risk.', approved_alternative: 'acetaminophen'});
    expect(f.tone).toBe('danger');
    expect(f.lines).toEqual(['GI bleed risk.', 'Safer option: acetaminophen']);
  });

  it('lists remedy steps and safety badges', () => {
    const f = cardFacts('PANTRY_REMEDY', {remedy_title: 'Ginger tea', preparation_steps: ['Boil.', 'Steep.'], safety_badges: ['Glycemic-Safe']});
    expect(f).toMatchObject({title: 'Ginger tea', lines: ['Boil.', 'Steep.', 'Glycemic-Safe']});
  });

  it('formats the restock total and tolerates a malformed payload', () => {
    expect(cardFacts('AMAZON_RESTOCK_CAROUSEL', {total_usd: 11.4, items: [{name: 'Motrin'}], eta: 'Tomorrow'})).toMatchObject({headline: '$11.40', lines: ['Motrin', 'Arrives Tomorrow']});
    expect(() => cardFacts('SYRINGE_CALIBRATOR', {})).not.toThrow();
    expect(cardFacts('DOUBLE_DOSE_INTERCEPT', {})).toMatchObject({title: 'Dose lock', lines: []});
  });
});
