import {describe, expect, it} from 'vitest';
import type {TurnEvent} from '../src/api/types';
import {conversationReducer, initialConversation, type ConversationAction, type ConversationState} from '../src/conversation/reducer';

const run = (actions: ConversationAction[], from: ConversationState = initialConversation) => actions.reduce(conversationReducer, from);
const turn = (events: TurnEvent[], turnId = 't1'): ConversationAction[] => events.map((event) => ({type: 'turn_event', turnId, event}));

describe('conversationReducer', () => {
  it('marks busy on send and clears stale alerts', () => {
    const s = run([{type: 'user_sent', id: 'u1', text: 'hi'}], {...initialConversation, alertText: 'old'});
    expect(s).toMatchObject({busy: true, progress: 'Thinking…', alertText: undefined});
    expect(s.messages).toEqual([{id: 'u1', role: 'user', text: 'hi'}]);
  });

  it('shows tool progress, keeps the card, appends the reply, and settles on done', () => {
    const s = run([
      {type: 'user_sent', id: 'u1', text: 'dose'},
      ...turn([
        {seq: 1, type: 'tool_call', data: {id: 'a', name: 'calculate_pediatric_dose', input: {}}},
      ]),
    ]);
    expect(s.progress).toBe('Calculating dose…');

    const end = run(
      turn([
        {seq: 2, type: 'card', data: {card_type: 'SYRINGE_CALIBRATOR', tool: 'calculate_pediatric_dose', payload: {dispense_volume_ml: 2}}},
        {seq: 3, type: 'assistant_delta', data: {text: 'Give 2 mL.'}},
        {seq: 4, type: 'done', data: {}},
      ]),
      s,
    );
    expect(end).toMatchObject({busy: false, progress: undefined});
    expect(end.card).toEqual({key: 't1-2', cardType: 'SYRINGE_CALIBRATOR', payload: {dispense_volume_ml: 2}});
    expect(end.messages.at(-1)).toEqual({id: 't1-3', role: 'assistant', text: 'Give 2 mL.'});
  });

  it.each([
    ['BLOCKED', 'DOUBLE_DOSE_LOCKED', /too recently/],
    ['BLOCKED', 'DRUG_CONTRAINDICATION', /not safe with current/],
    ['REJECTED_LOCKED', null, /not safe to give/],
    ['SEEK_CARE', null, /Seek medical care/],
  ])('%s/%s raises an assertive alert', (kind, violation, want) => {
    const s = run(turn([{seq: 1, type: 'alert', data: {kind, violation_type: violation}}]));
    expect(s.alertText).toMatch(want);
  });

  it('does not alert the caregiver about server-side guardrail notes', () => {
    const s = run(turn([{seq: 1, type: 'alert', data: {kind: 'GUARDRAIL_REPLACED', offending: ['3 mL']}}]));
    expect(s.alertText).toBeUndefined();
  });

  it('a failed turn surfaces a message and stops busy', () => {
    const s = run([{type: 'user_sent', id: 'u1', text: 'x'}, {type: 'turn_failed', id: 'e1', message: 'Cannot reach server'}]);
    expect(s).toMatchObject({busy: false, progress: undefined});
    expect(s.messages.at(-1)).toEqual({id: 'e1', role: 'assistant', text: 'Cannot reach server'});
  });

  it('caps history so a long session cannot grow without bound', () => {
    const many: ConversationAction[] = Array.from({length: 60}, (_, i) => ({type: 'user_sent', id: `u${i}`, text: `${i}`}));
    const s = run(many);
    expect(s.messages).toHaveLength(40);
    expect(s.messages.at(-1)!.id).toBe('u59');
  });

  it('clear_card removes only the card', () => {
    const s = run([...turn([{seq: 1, type: 'card', data: {card_type: 'PANTRY_REMEDY', tool: 'q', payload: {}}}]), {type: 'clear_card'}]);
    expect(s.card).toBeUndefined();
  });
});
