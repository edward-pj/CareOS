import type {CardType, TurnEvent} from '../api/types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface ActiveCard {
  key: string;
  cardType: CardType;
  payload: Record<string, unknown>;
}

export interface ConversationState {
  messages: ChatMessage[];
  card?: ActiveCard;
  busy: boolean;
  /** What the assistant is doing right now, e.g. "Checking safety…". */
  progress?: string;
  /** Spoken assertively by VoiceView: lockouts and blocks only. */
  alertText?: string;
}

export type ConversationAction =
  | {type: 'user_sent'; id: string; text: string}
  | {type: 'turn_event'; turnId: string; event: TurnEvent}
  | {type: 'turn_failed'; id: string; message: string}
  | {type: 'clear_card'};

export const initialConversation: ConversationState = {messages: [], busy: false};

const TOOL_PROGRESS: Record<string, string> = {
  calculate_pediatric_dose: 'Calculating dose…',
  verify_medication_safety: 'Checking safety…',
  log_administration_event: 'Recording dose…',
  query_pantry_remedies: 'Looking in the pantry…',
  stage_amazon_cart: 'Staging restock…',
  confirm_amazon_order: 'Placing order…',
};

const MAX_MESSAGES = 40;

const ALERT_COPY: Record<string, string> = {
  DOUBLE_DOSE_LOCKED: 'Blocked. A dose was given too recently.',
  DAILY_MAX: 'Blocked. Daily maximum reached.',
  DRUG_CONTRAINDICATION: 'Blocked. This medicine is not safe with current prescriptions.',
  AGE_GATE: 'Blocked. Not approved at this age.',
};

function alertFor(kind: string, violation?: string | null): string | undefined {
  if (kind === 'SEEK_CARE') {
    return 'Do not give medication. Seek medical care.';
  }
  if (kind === 'BLOCKED' || kind.startsWith('REJECTED_')) {
    return (violation && ALERT_COPY[violation]) || 'Blocked. This is not safe to give.';
  }
  return undefined; // GUARDRAIL_REPLACED etc. are server-side notes, not for the caregiver
}

const cap = (messages: ChatMessage[]) => (messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages);

export function conversationReducer(state: ConversationState, action: ConversationAction): ConversationState {
  switch (action.type) {
    case 'user_sent':
      return {
        ...state,
        busy: true,
        progress: 'Thinking…',
        alertText: undefined,
        messages: cap([...state.messages, {id: action.id, role: 'user', text: action.text}]),
      };

    case 'turn_failed':
      return {
        ...state,
        busy: false,
        progress: undefined,
        messages: cap([...state.messages, {id: action.id, role: 'assistant', text: action.message}]),
      };

    case 'clear_card':
      return {...state, card: undefined};

    case 'turn_event': {
      const {event, turnId} = action;
      switch (event.type) {
        case 'tool_call':
          return {...state, progress: TOOL_PROGRESS[event.data.name] ?? 'Working…'};
        case 'card':
          return {
            ...state,
            card: {key: `${turnId}-${event.seq}`, cardType: event.data.card_type, payload: event.data.payload},
          };
        case 'alert': {
          const text = alertFor(event.data.kind, event.data.violation_type);
          return text ? {...state, alertText: text} : state;
        }
        case 'assistant_delta':
          return {
            ...state,
            messages: cap([...state.messages, {id: `${turnId}-${event.seq}`, role: 'assistant', text: event.data.text}]),
          };
        case 'done':
          return {...state, busy: false, progress: undefined};
        default:
          return state; // tool_result / error carry no UI of their own (the reply text follows)
      }
    }
  }
}
