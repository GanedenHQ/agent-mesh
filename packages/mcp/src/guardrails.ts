/**
 * Anti-loop guardrails (docs/agent-guardrails.md).
 *
 * Two independent guards, never coupled:
 *  - hop limit: a thread may bounce at most N times between sessions without a
 *    human in between. Stops two agents politely answering each other forever.
 *  - send quota: at most Q messages per sender in any 60 s window. Backstop for
 *    everything the hop count misses (new thread every time, fan-out, a human
 *    who keeps re-arming the thread).
 *
 * There is no server, so the sending process enforces both. That stops runaway
 * sessions, not a hostile process of the same OS user, which could write the
 * mailbox files directly: on one machine, the machine is the trust boundary.
 */

export const DEFAULT_HOP_LIMIT = 12;
export const DEFAULT_QUOTA_PER_MIN = 30;
export const QUOTA_WINDOW_MS = 60_000;

export interface GuardLimits {
  hopLimit: number;
  quotaPerMin: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function limitsFromEnv(env: Record<string, string | undefined> = process.env): GuardLimits {
  return {
    hopLimit: positiveInt(env['MESH_HOP_LIMIT'], DEFAULT_HOP_LIMIT),
    quotaPerMin: positiveInt(env['MESH_QUOTA_PER_MIN'], DEFAULT_QUOTA_PER_MIN),
  };
}

/** What the thread looked like before this message. */
export interface ThreadState {
  /** hop count of the last message in the thread */
  hop: number;
  /** whether a human sent that last message */
  lastFromHuman: boolean;
}

/**
 * Hop count of a new message: 0 on a new thread or right after a human,
 * otherwise one more than the previous message.
 */
export function nextHop(prev: ThreadState | null, limits: GuardLimits): number {
  const hop = !prev || prev.lastFromHuman ? 0 : prev.hop + 1;
  if (hop > limits.hopLimit) throw new LoopGuardError('hop_limit', limits.hopLimit, hop);
  return hop;
}

/**
 * Enforce the quota over the sender's recent send times (ms epoch). Returns the
 * timestamps still inside the window, plus `now`, ready to be stored back.
 */
export function checkQuota(sentAt: number[], now: number, limits: GuardLimits): number[] {
  const recent = sentAt.filter((t) => now - t < QUOTA_WINDOW_MS);
  if (recent.length >= limits.quotaPerMin) {
    throw new LoopGuardError('quota_per_min', limits.quotaPerMin);
  }
  return [...recent, now];
}

export type GuardReason = 'hop_limit' | 'quota_per_min';

/**
 * A refused send. The text is written for the agent that reads it: what
 * happened, and what to do instead of retrying.
 */
export class LoopGuardError extends Error {
  constructor(
    readonly reason: GuardReason,
    readonly limit: number,
    readonly hop?: number,
  ) {
    super(guardMessage(reason, limit));
    this.name = 'LoopGuardError';
  }
}

export function guardMessage(reason: GuardReason, limit: number): string {
  return reason === 'hop_limit'
    ? `loop guard: this thread has gone back and forth ${limit} times between sessions ` +
        `without a human, so the message was not sent. Stop replying in this thread and ` +
        `tell your user what is going on. If they ask you to continue, start a new thread ` +
        `(send without threadId).`
    : `rate limit: you sent ${limit} messages in the last 60 seconds, so this one was not ` +
        `sent. Check that you are not stuck in a reply loop, then wait a minute before sending again.`;
}
