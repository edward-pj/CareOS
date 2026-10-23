import type { CardType, NumericGuardEvent, TurnEvent } from "../api/types";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** What to do next, from the tool (kept apart from `text`, which is the two-sentence spoken answer). */
  followup?: string;
}

/** A model draft the Numeric Guard threw away, kept for the inspector's Numeric Guard log. */
export interface GuardLogEntry extends NumericGuardEvent {
  id: string;
  at: number;
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
  /** Every Numeric Guard intervention this session, newest last. */
  guardLog: GuardLogEntry[];
}

export type ConversationAction =
  | { type: "user_sent"; id: string; text: string }
  | { type: "local_exchange"; userId: string; text: string; replyId: string; reply: string }
  | { type: "turn_event"; turnId: string; event: TurnEvent }
  | { type: "turn_failed"; id: string; message: string }
  /** A result the screen fetched itself (a photo read), shown exactly like a tool result from a spoken request. */
  | { type: "show_payload"; userId: string; userText: string; replyId: string; payload: Record<string, unknown> };

export const initialConversation: ConversationState = { messages: [], steps: [], busy: false, guardLog: [] };

// Same pattern as the server's BLOCKING_STATUS: statuses that stop the caregiver. Questions (NEEDS_INFO,
// NEEDS_CONFIRMATION) are not alarms.
const BLOCKING = /^(BLOCKED|REJECTED_.*|ALTERNATE_SUGGESTED|NEEDS_CLINICIAN|MEMORY_CONFLICT|SEEK_CARE|CALL_EMERGENCY|GO_TO_ER_NOW|CALL_DOCTOR_TODAY)$/;
const MAX_MESSAGES = 60;
const MAX_GUARD_LOG = 20;
const cap = (m: ChatMessage[]) => (m.length > MAX_MESSAGES ? m.slice(-MAX_MESSAGES) : m);

const ALERT_COPY: Record<string, string> = {
  DOUBLE_DOSE_LOCKED: "Blocked. A dose was given too recently.",
  DAILY_MAX: "Blocked. Daily maximum reached.",
  DRUG_CONTRAINDICATION: "Blocked. This medicine is not safe with current prescriptions.",
  CONDITION: "Not safe. This medicine conflicts with a health condition.",
  AGE_GATE: "Blocked. Not approved at this age.",
  ALLERGY: "Blocked. This person has a recorded allergy.",
  DUPLICATE_INGREDIENT: "Blocked. This duplicates a medicine already being taken.",
  PRODUCT_NOT_FOR_PATIENT: "Blocked. This product is not labelled for this person.",
};

export function alertFor(kind: string, violation?: string | null): string | undefined {
  if (kind === "CALL_EMERGENCY") return "Possible emergency. Call for help now.";
  if (kind === "GO_TO_ER_NOW") return "Needs to be seen right away.";
  if (kind === "CALL_DOCTOR_TODAY") return "Call your doctor or nurse line.";
  if (kind === "SEEK_CARE") return "Do not give medication. Seek medical care.";
  if (kind === "NEEDS_CLINICIAN") return "Ask a clinician before giving this.";
  if (kind === "ALTERNATE_SUGGESTED") return (violation && ALERT_COPY[violation]) || "Not safe to give. A safer option is suggested.";
  if (kind === "MEMORY_CONFLICT") return "That old advice is no longer safe.";
  if (kind === "BLOCKED" || kind.startsWith("REJECTED_")) return (violation && ALERT_COPY[violation]) || "Blocked. This is not safe to give.";
  return undefined; // GUARDRAIL_REPLACED has its own numeric_guard event
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

    case "show_payload": {
      const p = action.payload;
      const status = typeof p.status === "string" ? p.status : "";
      const cardType = (typeof p.card_type === "string" ? p.card_type : undefined) as CardType | undefined;
      const speech = typeof p.speech === "string" ? p.speech : "";
      return {
        ...state,
        busy: false,
        progress: undefined,
        alertText: BLOCKING.test(status) ? alertFor(status, typeof p.violation_type === "string" ? p.violation_type : null) : undefined,
        card: cardType ? { key: action.replyId, cardType, payload: p } : undefined,
        // The Rail's "tool used" chip names what produced this result (the screen called it directly, not the model).
        steps: [{ id: action.replyId, name: cardType === "RX_CONFIRMATION" ? "manage_prescriptions" : cardType === "LABEL_LENS" ? "read_bottle_label" : "photo", input: {}, state: BLOCKING.test(status) ? "blocked" as const : "ok" as const, status, payload: p }],
        messages: cap([
          ...state.messages,
          { id: action.userId, role: "user", text: action.userText },
          ...(speech ? [{ id: action.replyId, role: "assistant" as const, text: speech, followup: typeof p.followup === "string" ? p.followup : undefined }] : []),
        ]),
      };
    }

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
        case "numeric_guard":
          return {
            ...state,
            alertText: "Alexa drafted a number the safety engine never gave. It was replaced with the verified answer.",
            guardLog: [...state.guardLog, { ...event.data, id: `${turnId}-${event.seq}`, at: Date.now() }].slice(-MAX_GUARD_LOG),
          };
        case "assistant_delta":
          return { ...state, messages: cap([...state.messages, { id: `${turnId}-${event.seq}`, role: "assistant", text: event.data.text, followup: event.data.followup }]) };
        case "done":
          return { ...state, busy: false, progress: undefined };
        default:
          return state;
      }
    }
  }
}

/** What the caregiver last said, and the last tool the assistant used: the "what Alexa heard / tool used" chips. */
export function lastHeard(state: ConversationState): string | undefined {
  return [...state.messages].reverse().find((m) => m.role === "user")?.text;
}
export function lastToolUsed(state: ConversationState): string | undefined {
  return state.steps.at(-1)?.name;
}

/** The text to speak for a reply: the answer, then its follow-up instruction. */
export function spokenText(m: { text: string; followup?: string }): string {
  return m.followup ? `${m.text} ${m.followup}` : m.text;
}

/** Client-side intent: "switch caregiver shift to Grandma". Returns the caregiver name to switch to, if any. */
export function parseShiftSwitch(text: string, caregivers: Array<{ name: string }>): string | undefined {
  if (!/\b(switch|change|hand\s?off|hand over)\b/i.test(text) || !/\b(caregiver|shift)\b/i.test(text)) return undefined;
  const lower = text.toLowerCase();
  return caregivers.find((c) => lower.includes(c.name.toLowerCase()))?.name;
}
