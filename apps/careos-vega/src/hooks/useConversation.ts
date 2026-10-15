import {useCallback, useEffect, useReducer, useRef} from 'react';
import {api, ApiError} from '../api/client';
import {followTurn, type CancelFlag} from '../conversation/poll';
import {conversationReducer, initialConversation, type ConversationState} from '../conversation/reducer';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function failureMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409) {
      return "I'm still working on your last question.";
    }
    if (e.status === 503) {
      return "CareOS isn't ready yet. Try again in a moment.";
    }
    return e.message;
  }
  return 'Something went wrong. Please try again.';
}

export interface Conversation extends ConversationState {
  send: (text: string) => Promise<void>;
  clearCard: () => void;
}

/** One conversation session. Replies arrive by cursor long-poll (see conversation/poll.ts). */
export function useConversation(activeProfile: string, caregiver: string): Conversation {
  const [state, dispatch] = useReducer(conversationReducer, initialConversation);
  const sessionId = useRef(newId()).current;
  const cancel = useRef<CancelFlag>({cancelled: false});
  const inFlight = useRef(false);

  useEffect(() => {
    const flag = cancel.current;
    flag.cancelled = false;
    return () => {
      flag.cancelled = true;
    };
  }, []);

  const send = useCallback(
    async (text: string) => {
      const transcript = text.trim();
      if (!transcript || inFlight.current) {
        return;
      }
      inFlight.current = true;
      dispatch({type: 'user_sent', id: `u-${newId()}`, text: transcript});
      try {
        const {turn_id} = await api.converse({
          session_id: sessionId,
          active_profile: activeProfile,
          caregiver,
          transcript,
        });
        await followTurn(
          turn_id,
          {fetchEvents: (id, after) => api.getTurnEvents(id, after), sleep},
          (event) => dispatch({type: 'turn_event', turnId: turn_id, event}),
          cancel.current,
        );
      } catch (e) {
        if (!cancel.current.cancelled) {
          dispatch({type: 'turn_failed', id: `e-${newId()}`, message: failureMessage(e)});
        }
      } finally {
        inFlight.current = false;
      }
    },
    [activeProfile, caregiver, sessionId],
  );

  const clearCard = useCallback(() => dispatch({type: 'clear_card'}), []);

  return {...state, send, clearCard};
}
