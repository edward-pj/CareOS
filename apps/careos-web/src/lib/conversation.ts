import type { CardType, TurnEvent } from "../api/types";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** One MCP tool invocation the model made during the current turn (the "Agent Execution Trace"). */
export interface TraceStep {
  id: string;
  name: string;
  input: Record<string, unknown>;
  state: "running" | "ok" | "blocked" | "error";
  status?: string;
  /** The tool's JSON payload, when it produced a card. */
  payload?: Record<string, unknown>;
}

export interface ActiveCard {
  key: string;
  cardType: CardType;
  payload: Record<string, unknown>;
}

export interface ConversationState {
  messages: ChatMessage[];
  steps: TraceStep[];
  card?: ActiveCard;
  busy: boolean;
  progress?: string;
  alertText?: string;
}

export type ConversationAction =
  | { type: "user_sent"; id: string; text: string }
  | { type: "local_exchange"; userId: string; text: string; replyId: string; reply: string }
  | { type: "turn_event"; turnId: string; event: TurnEvent }
  | { type: "turn_failed"; id: string; message: string };

export const initialConversation: ConversationState = { messages: [], steps: [], busy: false };

const BLOCKING = /^(BLOCKED|REJECTED_.*|OVERRIDE_DENIED|SEEK_CARE)$/;
const MAX_MESSAGES = 60;
const cap = (m: ChatMessage[]) => (m.length > MAX_MESSAGES ? m.slice(-MAX_MESSAGES) : m);

const ALERT_COPY: Record<string, string> = {
  DOUBLE_DOSE_LOCKED: "Blocked. A dose was given too recently.",
  DAILY_MAX: "Blocked. Daily maximum reached.",
  DRUG_CONTRAINDICATION: "Blocked. This medicine is not safe with current prescriptions.",
  AGE_GATE: "Blocked. Not approved at this age.",
};

export function alertFor(kind: string, violation?: string | null): string | undefined {
  if (kind === "SEEK_CARE") return "Do not give medication. Seek medical care.";
  if (kind === "BLOCKED" || kind.startsWith("REJECTED_")) return (violation && ALERT_COPY[violation]) || "Blocked. This is not safe to give.";
  return undefined; // GUARDRAIL_REPLACED etc. are server-side notes
}

export function conversationReducer(state: ConversationState, action: ConversationAction): ConversationState {
  switch (action.type) {
    case "user_sent":
      return {
        ...state,
        busy: true,
        progress: "Thinking…",
        alertText: undefined,
        card: undefined,
        steps: [],
        messages: cap([...state.messages, { id: action.id, role: "user", text: action.text }]),
      };

    case "local_exchange":
      return {
        ...state,
        messages: cap([
          ...state.messages,
          { id: action.userId, role: "user", text: action.text },
          { id: action.replyId, role: "assistant", text: action.reply },
        ]),
      };

    case "turn_failed":
      return { ...state, busy: false, progress: undefined, messages: cap([...state.messages, { id: action.id, role: "assistant", text: action.message }]) };

    case "turn_event": {
      const { event, turnId } = action;
      switch (event.type) {
        case "tool_call":
          return {
            ...state,
            progress: `Running ${event.data.name}…`,
            steps: [...state.steps, { id: event.data.id, name: event.data.name, input: event.data.input, state: "running" }],
          };
        case "tool_result": {
          const next: TraceStep["state"] = event.data.is_error ? "error" : event.data.status && BLOCKING.test(event.data.status) ? "blocked" : "ok";
          return {
            ...state,
            steps: state.steps.map((s) => (s.id === event.data.id ? { ...s, state: next, status: event.data.status } : s)),
          };
        }
        case "card": {
          const idx = state.steps.map((s) => s.name).lastIndexOf(event.data.tool);
          return {
            ...state,
            card: { key: `${turnId}-${event.seq}`, cardType: event.data.card_type, payload: event.data.payload },
            steps: state.steps.map((s, i) => (i === idx ? { ...s, payload: event.data.payload } : s)),
          };
        }
        case "alert": {
          const text = alertFor(event.data.kind, event.data.violation_type);
          return text ? { ...state, alertText: text } : state;
        }
        case "assistant_delta":
          return { ...state, messages: cap([...state.messages, { id: `${turnId}-${event.seq}`, role: "assistant", text: event.data.text }]) };
        case "done":
          return { ...state, busy: false, progress: undefined };
        default:
          return state;
      }
    }
  }
}

/** Client-side intent: "switch caregiver shift to Grandma". Returns the caregiver name to switch to, if any. */
export function parseShiftSwitch(text: string, caregivers: Array<{ name: string }>): string | undefined {
  if (!/\b(switch|change|hand\s?off|hand over)\b/i.test(text) || !/\b(caregiver|shift)\b/i.test(text)) return undefined;
  const lower = text.toLowerCase();
  return caregivers.find((c) => lower.includes(c.name.toLowerCase()))?.name;
}
