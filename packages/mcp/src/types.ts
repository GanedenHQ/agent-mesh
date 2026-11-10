/** A message between two sessions, as stored in a mailbox file. */

export interface Message {
  id: string;
  from: string;
  to: string;
  threadId: string;
  content: string;
  /** ms epoch */
  createdAt: number;
  deliveredAt: number | null;
  ackedAt: number | null;
  /** Consecutive session-to-session bounces in the thread (see guardrails.ts). */
  hopCount?: number;
}

export interface UserSummary {
  username: string;
  online: boolean;
}
