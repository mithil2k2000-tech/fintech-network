// Domain module: audit
// Append-only record of security- and lifecycle-relevant events
// (spec §16 Audit System, §24 Observability). No update/delete API is
// exposed — audit_events rows are written once and never mutated.
import type { Queryable } from "../../db.js";

export const MODULE_NAME = "audit" as const;

export type AuditEventType =
  | "USER_REGISTERED"
  | "LOGIN"
  | "LOGIN_FAILED"
  | "UNAUTHORIZED_ACCESS_ATTEMPT"
  | "PAYMENT_CREATED"
  | "RISK_EVALUATED"
  | "PAYMENT_APPROVED"
  | "PAYMENT_COMPLETED"
  | "PAYMENT_FAILED"
  | "PAYMENT_CANCELLED"
  | "LEDGER_POSTED"
  | "RECEIPT_CREATED"
  | "PAYMENT_REQUEST_CREATED"
  | "PAYMENT_REQUEST_CANCELLED"
  | "PAYMENT_REQUEST_DECLINED"
  | "PAYMENT_REQUEST_PAID"
  | "BILL_SPLIT_CREATED"
  | "BILL_SPLIT_CANCELLED"
  | "MERCHANT_CREATED"
  | "MERCHANT_MEMBER_ADDED"
  | "CASHBACK_GRANTED"
  | "CASHBACK_FAILED"
  | "RISK_ASSESSMENT_NOT_RECORDED"
  /**
   * The assistant was asked something. The intent is recorded; the
   * question and the answer are not (spec §26 — a transcript of what
   * someone asked about their own money is data nobody needs to keep).
   */
  | "ASSISTANT_QUERY"
  | "ASSISTANT_DRAFT_REJECTED"
  /** Phase 14. Security events: who was held off, and what went stale. */
  | "LOGIN_THROTTLED"
  | "RECIPIENT_LOOKUP_FAILED"
  | "RECIPIENT_LOOKUP_THROTTLED"
  | "PAYMENT_APPROVAL_EXPIRED";

export interface RecordAuditEventInput {
  eventType: AuditEventType;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Accepts the pool or an in-transaction client, so an audit event can
 * commit (or roll back) together with the change it describes.
 */
export async function recordAuditEvent(
  q: Queryable,
  input: RecordAuditEventInput
): Promise<void> {
  await q.query(
    `insert into audit_events (event_type, actor_user_id, metadata)
     values ($1, $2, $3)`,
    [input.eventType, input.actorUserId ?? null, input.metadata ?? {}]
  );
}

/**
 * How often each kind of event has been recorded lately (Phase 15).
 * The audit trail is the only place some things are written down —
 * throttled sign-ins, rejected assistant drafts — so counting it is how
 * those become visible without a second store to keep in step.
 */
export async function countEventsSince(
  q: Queryable,
  hours: number,
  eventTypes?: AuditEventType[]
): Promise<{ eventType: string; count: number }[]> {
  const result = await q.query<{ event_type: string; count: string }>(
    `select event_type, count(*)::text as count
     from audit_events
     where created_at > now() - make_interval(hours => $1::int)
       and ($2::text[] is null or event_type = any($2::text[]))
     group by event_type
     order by count(*) desc`,
    [hours, eventTypes ?? null]
  );
  return result.rows.map((row) => ({ eventType: row.event_type, count: Number(row.count) }));
}
