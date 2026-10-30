/** One placed call. A terminal call never changes state again and is never redialled. */
export type PhoneCallState = "queued" | "dialling" | "ringing" | "in_progress" | "asking" | "taken_over" | "ended";
export type PhoneCallOutcome =
  | "completed"
  | "callback_needed"
  | "owner_took_over"
  | "busy"
  | "no_answer"
  | "voicemail"
  | "ended_by_owner"
  | "refused"
  | "dropped"
  | "failed";

/** Everything the voice agent may know. The owner approves it before dialling. */
export type PhoneBrief = {
  /** E.164 destination, for example +34910000000. */
  to: string;
  /** How the agent addresses the callee. */
  business?: string;
  /** The person the call is for, named in the first sentence. */
  onBehalfOf: string;
  goal: string;
  /** Facts the agent may say. */
  mayShare?: string[];
  /** Limits the agent never crosses. */
  mustNot?: string[];
  /** Ask the owner when the callee proposes something outside the brief, or end and call back. */
  ifOutsideLimits?: "ask" | "end";
  /** When to stop and ask the owner, holding the line until the answer or the question deadline. */
  checkIn?: string;
  voicemail?: "hang_up" | "leave_message";
  /** BCP 47 language for the opening; otherwise the agent follows the callee. */
  language?: string;
  /** Capped by the space's allowance. */
  maxMinutes?: number;
};

export type PhoneQuestion = {
  questionId: string;
  question: string;
  askedAt: number;
  deadlineAt: number;
  answer?: string;
  answeredBy?: "owner" | "ship";
  answeredAt?: number;
};

export type PhoneTranscriptLine = {
  at: number;
  speaker: "agent" | "callee" | "note" | "answer";
  text: string;
};

export type PhoneCall = {
  callId: string;
  requestId: string;
  ownerUid: number;
  /** The Process that placed the call, when an agent did. */
  processId?: string;
  responsibilityId?: string;
  brief: PhoneBrief;
  state: PhoneCallState;
  revision: number;
  outcome?: PhoneCallOutcome;
  /** The agent's account of the result for completed and callback_needed calls. */
  summary?: string;
  question?: PhoneQuestion;
  /** Whether the first response named the owner and an assistant. */
  disclosed?: boolean;
  createdAt: number;
  answeredAt?: number;
  endedAt?: number;
  durationSeconds?: number;
  reason?: string;
  diagnosticRef?: string;
};

export type PhoneUsage = {
  enabled: boolean;
  dayStartsAt: number;
  callsToday: number;
  dailyLimit: number;
  activeCalls: number;
  concurrentLimit: number;
  maxCallSeconds: number;
};

/** A brief as the caller writes it; the Kernel names the owner when onBehalfOf is omitted. */
export type PhoneBriefInput = Omit<PhoneBrief, "onBehalfOf"> & { onBehalfOf?: string };

export type SysPhoneCallArgs = {
  brief: PhoneBriefInput;
  responsibilityId?: string;
  /**
   * A retried request with the same identity returns the same call. The Kernel
   * derives it from the owning tool call when omitted.
   */
  requestId?: string;
};
export type SysPhoneCallResult = { call: PhoneCall };
export type SysPhoneGetArgs = { callId: string };
/** The transcript is available until the Kernel has filed it. */
export type SysPhoneGetResult = { call: PhoneCall; transcript?: PhoneTranscriptLine[]; transcriptPath?: string };
export type SysPhoneListArgs = { includeEnded?: boolean };
export type SysPhoneListResult = { calls: PhoneCall[]; usage: PhoneUsage };
export type SysPhoneAnswerArgs = { callId: string; questionId: string; answer: string };
export type SysPhoneAnswerResult = { call: PhoneCall };
export type SysPhoneNoteArgs = { callId: string; note: string };
export type SysPhoneNoteResult = { call: PhoneCall };
export type SysPhoneEndArgs = { callId: string };
export type SysPhoneEndResult = { call: PhoneCall };
/** The body streams newline-delimited PhoneWatchEvent JSON until the call ends or the reader closes. */
export type SysPhoneWatchArgs = { callId: string };
export type SysPhoneWatchResult = { call: PhoneCall };
export type PhoneWatchEvent =
  | { kind: "call"; call: PhoneCall }
  | { kind: "line"; line: PhoneTranscriptLine };
export type SysPhoneJoinArgs = { callId: string };
/**
 * A short-lived telephony client credential bound to one call. The client places
 * one outgoing connection with `connectParams`; the service then moves the callee to it.
 */
export type SysPhoneJoinResult = {
  call: PhoneCall;
  provider: "twilio";
  token: string;
  identity: string;
  expiresAt: number;
  connectParams: Record<string, string>;
};
