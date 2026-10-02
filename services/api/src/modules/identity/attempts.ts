import type { Queryable } from "../../db.js";

// Counting recent failures, from the audit trail that was already being
// written (Phase 14).
//
// The point of reading the audit trail rather than keeping a counter
// somewhere: the thing that decides to hold an account off and the thing
// that would be looked at afterwards to explain why are then the same
// record. A separate counter can disagree with the evidence; this can't.
//
// Its limit, said out loud: this is a table scan over a JSON field, and
// at real volumes it wants its own index or a counter in front of it.
// For a prototype with an audit table this size it's the right trade —
// no new state, nothing to keep in step.

/**
 * Failed sign-ins for one email address within the window. Counted by
 * address rather than by account, so attempts against an email that
 * isn't registered are counted the same way — otherwise the throttle
 * itself would tell an attacker which addresses exist.
 */
export async function countRecentLoginFailures(
  q: Queryable,
  email: string,
  windowMinutes: number
): Promise<number> {
  const result = await q.query<{ count: string }>(
    `select count(*)::text as count
     from audit_events
     where event_type = 'LOGIN_FAILED'
       and metadata->>'email' = $1
       and created_at > now() - make_interval(mins => $2::int)`,
    [email.toLowerCase(), windowMinutes]
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * How many times this payer has tried to pay an address that isn't
 * registered, in the last hour. A payer has to be told when they've
 * typed an address wrong, so this endpoint can't be made opaque — but
 * someone working through a list of addresses looks nothing like
 * someone mistyping one, and this is what tells them apart.
 */
export async function countRecentRecipientLookupFailures(
  q: Queryable,
  payerUserId: string,
  windowMinutes = 60
): Promise<number> {
  const result = await q.query<{ count: string }>(
    `select count(*)::text as count
     from audit_events
     where event_type = 'RECIPIENT_LOOKUP_FAILED'
       and actor_user_id = $1
       and created_at > now() - make_interval(mins => $2::int)`,
    [payerUserId, windowMinutes]
  );
  return Number(result.rows[0]?.count ?? 0);
}
