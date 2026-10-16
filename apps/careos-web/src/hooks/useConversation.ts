import { useCallback, useEffect, useReducer, useRef } from "react";
import { api, ApiError, followTurn } from "../api/client";
import { conversationReducer, initialConversation, parseShiftSwitch, type ConversationState } from "../lib/conversation";

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function failureMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409) return "I'm still working on your last question.";
    if (e.status === 503) return "CareOS isn't ready yet. Try again in a moment.";
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong. Please try again.";
}

export interface Conversation extends ConversationState {
  send: (text: string) => Promise<void>;
}

interface Options {
  activeProfile: string;
  caregiver: string;
  caregivers: Array<{ name: string }>;
  onSwitchCaregiver: (name: string) => void;
  /** Called after each reply is complete, e.g. to speak it. */
  onReply?: (text: string) => void;
}

export function useConversation({ activeProfile, caregiver, caregivers, onSwitchCaregiver, onReply }: Options): Conversation {
  const [state, dispatch] = useReducer(conversationReducer, initialConversation);
  const sessionId = useRef(newId()).current;
  const inFlight = useRef(false);
  const cancel = useRef<(() => void) | undefined>(undefined);

  useEffect(() => () => cancel.current?.(), []);

  const send = useCallback(
    async (text: string) => {
      const transcript = text.trim();
      if (!transcript || inFlight.current) return;

      const target = parseShiftSwitch(transcript, caregivers);
      if (target) {
        onSwitchCaregiver(target);
        const reply = `Okay. ${target} is now the active caregiver.`;
        dispatch({ type: "local_exchange", userId: `u-${newId()}`, text: transcript, replyId: `a-${newId()}`, reply });
        onReply?.(reply);
        return;
      }

      inFlight.current = true;
      dispatch({ type: "user_sent", id: `u-${newId()}`, text: transcript });
      try {
        const { turn_id } = await api.converse({ session_id: sessionId, active_profile: activeProfile, caregiver, transcript });
        await new Promise<void>((resolve, reject) => {
          cancel.current = followTurn(
            turn_id,
            (event) => {
              dispatch({ type: "turn_event", turnId: turn_id, event });
              if (event.type === "assistant_delta") onReply?.(event.data.text);
              if (event.type === "done") resolve();
            },
            reject,
          );
        });
      } catch (e) {
        dispatch({ type: "turn_failed", id: `e-${newId()}`, message: failureMessage(e) });
      } finally {
        inFlight.current = false;
      }
    },
    [activeProfile, caregiver, caregivers, onReply, onSwitchCaregiver, sessionId],
  );

  return { ...state, send };
}
