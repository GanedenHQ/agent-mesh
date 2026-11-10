/**
 * Presence attests that a session is OPEN — never that a message reached it.
 *
 * A session can be alive while its Claude never reads the push (channels
 * disabled, session busy or stuck). Saying "delivered" on the strength of
 * presence sends people hunting for a failure that is not there, so a send
 * result reports what presence saw and nothing more.
 */

/** The slice of presence this needs — satisfied by `Mailbox`. */
export interface PresenceView {
  /**
   * True once this session has started and can read presence. Before that the
   * online set is empty because nothing has been read yet, and reporting it as
   * "nobody is connected" would be a false claim of its own.
   */
  readonly presenceObserved: boolean;
  isOnline(username: string): boolean;
}

/**
 * What a send result can honestly report: the server took the row, plus whatever
 * presence — and only presence — says about the recipient's sessions.
 */
export function deliveryStatus(to: string, presence: PresenceView): string {
  if (!presence.presenceObserved) {
    return '📤 sent — presence not read here; nothing observed about the recipient';
  }
  // Both branches hedge, and symmetrically: presence is one weak signal, and it
  // is no more reliable when it says "absent" than when it says "present".
  return presence.isOnline(to)
    ? '📤 sent — a session for the recipient is connected (presence, not a delivery receipt)'
    : '📤 sent — no session seen for the recipient; it waits in their inbox';
}
