/**
 * Tool statuses that stop the caregiver and raise the red alert. NEEDS_INFO and NEEDS_CONFIRMATION are questions, not alarms.
 * (The web app keeps its own copy of this pattern in lib/conversation.ts: it never imports server code.)
 */
export const BLOCKING_STATUS = /^(BLOCKED|REJECTED_.*|ALTERNATE_SUGGESTED|NEEDS_CLINICIAN|MEMORY_CONFLICT|SEEK_CARE|CALL_EMERGENCY|GO_TO_ER_NOW|CALL_DOCTOR_TODAY)$/;
