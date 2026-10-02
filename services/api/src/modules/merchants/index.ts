// Domain module: merchants — shops that can be paid.
//
// The only writer to `merchants` and `merchant_members`. Everything
// else asks this module who a merchant is and whether someone may act
// for one; nothing else decides that.
//
// A merchant is not a user. It has no password and cannot sign in: a
// person signs in as themselves and acts for a shop they're a member
// of. That keeps one identity per human and makes the audit trail say
// which person took the money, not just which shop.
//
// Money-wise there is nothing new here. A merchant owns a ledger
// account exactly as a user does ((owner_type, owner_id) since Phase
// 3), so payments to a shop travel the same double-entry path as
// payments to a person.
import type { Pool } from "pg";
import type { MinorUnits } from "@fintech-network/shared-types";
import type { Queryable } from "../../db.js";
import { recordAuditEvent } from "../audit/index.js";
import { findUserByEmail } from "../users/index.js";
import { getBalanceMinorUnits, getOrCreateAccountForOwner } from "../ledger/index.js";

export const MODULE_NAME = "merchants" as const;

export type MerchantRole = "owner" | "staff";
export type MerchantStatus = "active" | "suspended";
/**
 * How far we vouch for a shop being who it says it is. This prototype
 * runs no onboarding checks at all, so it is always 'unverified' and
 * the customer-facing wording has to say as much.
 */
export type MerchantVerification = "unverified" | "verified";

export class MerchantError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string
  ) {
    super(message);
    this.name = "MerchantError";
  }
}

interface MerchantRow {
  id: string;
  legal_name: string;
  trading_name: string;
  contact_email: string;
  status: MerchantStatus;
  verification: MerchantVerification;
  created_by_user_id: string;
  created_at: Date;
}

export interface Merchant {
  id: string;
  legalName: string;
  tradingName: string;
  contactEmail: string;
  status: MerchantStatus;
  verification: MerchantVerification;
  createdAt: string;
}

/** A merchant as one of its members sees it, with their own role. */
export interface MerchantMembershipView extends Merchant {
  yourRole: MerchantRole;
}

export interface MerchantMemberView {
  userId: string;
  displayName: string;
  role: MerchantRole;
  isYou: boolean;
  addedAt: string;
}

function toMerchant(row: MerchantRow): Merchant {
  return {
    id: row.id,
    legalName: row.legal_name,
    tradingName: row.trading_name,
    contactEmail: row.contact_email,
    status: row.status,
    verification: row.verification,
    createdAt: row.created_at.toISOString(),
  };
}

function notFound(): MerchantError {
  // Not being a member looks the same as the shop not existing.
  return new MerchantError("MERCHANT_NOT_FOUND", 404, "Shop not found");
}

export async function findMerchantById(q: Queryable, id: string): Promise<Merchant | null> {
  const result = await q.query<MerchantRow>(`select * from merchants where id = $1`, [id]);
  return result.rows[0] ? toMerchant(result.rows[0]) : null;
}

/** Trading names for a set of merchant ids, for lists that show payees. */
export async function findMerchantNames(
  q: Queryable,
  ids: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const result = await q.query<{ id: string; trading_name: string }>(
    `select id, trading_name from merchants where id = any($1::uuid[])`,
    [unique]
  );
  return new Map(result.rows.map((r) => [r.id, r.trading_name]));
}

export async function getMembership(
  q: Queryable,
  merchantId: string,
  userId: string
): Promise<MerchantRole | null> {
  const result = await q.query<{ role: MerchantRole }>(
    `select role from merchant_members where merchant_id = $1 and user_id = $2`,
    [merchantId, userId]
  );
  return result.rows[0]?.role ?? null;
}

/**
 * The gate every merchant action goes through. Returns the caller's
 * role, or throws — 404 if they're not a member (so shop ids can't be
 * probed), 403 if they are but lack the role, 409 if the shop is
 * suspended and the action would move money.
 */
export async function requireMembership(
  q: Queryable,
  merchantId: string,
  userId: string,
  options: { role?: MerchantRole; mustBeActive?: boolean } = {}
): Promise<{ merchant: Merchant; role: MerchantRole }> {
  const merchant = await findMerchantById(q, merchantId);
  const role = merchant ? await getMembership(q, merchantId, userId) : null;
  if (!merchant || !role) throw notFound();
  if (options.role === "owner" && role !== "owner") {
    throw new MerchantError(
      "MERCHANT_OWNER_ONLY",
      403,
      "Only an owner of this shop can do that"
    );
  }
  if (options.mustBeActive && merchant.status !== "active") {
    throw new MerchantError(
      "MERCHANT_SUSPENDED",
      409,
      "This shop can't take payments at the moment"
    );
  }
  return { merchant, role };
}

export interface CreateMerchantInput {
  userId: string;
  legalName: string;
  tradingName: string;
  contactEmail: string;
}

/**
 * Registers a shop with the person creating it as its first owner, and
 * opens its ledger account — all in one transaction, so a shop can
 * never exist with nobody able to reach it.
 *
 * Note what this does NOT do: check that the shop is real, that the
 * person runs it, or that the name is theirs to use. That is business
 * onboarding (KYB) and is out of scope here.
 */
export async function createMerchant(
  pool: Pool,
  input: CreateMerchantInput
): Promise<MerchantMembershipView> {
  const legalName = input.legalName.trim();
  const tradingName = input.tradingName.trim();
  const contactEmail = input.contactEmail.trim().toLowerCase();
  if (!legalName || !tradingName || !contactEmail) {
    throw new MerchantError("MERCHANT_INVALID", 400, "Give the shop a name and a contact email");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    let row: MerchantRow;
    try {
      const created = await client.query<MerchantRow>(
        `insert into merchants (legal_name, trading_name, contact_email, created_by_user_id)
         values ($1, $2, $3, $4)
         returning *`,
        [legalName, tradingName, contactEmail, input.userId]
      );
      row = created.rows[0];
    } catch (err) {
      if (err instanceof Error && /merchants_trading_name_unique/.test(err.message)) {
        throw new MerchantError(
          "MERCHANT_NAME_TAKEN",
          409,
          "Another shop is already trading under that name"
        );
      }
      throw err;
    }

    await client.query(
      `insert into merchant_members (merchant_id, user_id, role, added_by_user_id)
       values ($1, $2, 'owner', $2)`,
      [row.id, input.userId]
    );
    // Open the ledger account now, so the shop's balance exists from
    // the start rather than appearing with its first payment.
    await getOrCreateAccountForOwner(client, "merchant", row.id);

    await recordAuditEvent(client, {
      eventType: "MERCHANT_CREATED",
      actorUserId: input.userId,
      metadata: { merchantId: row.id, tradingName },
    });
    await client.query("commit");
    return { ...toMerchant(row), yourRole: "owner" };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The shops this person can act for. */
export async function listMerchantsForUser(
  pool: Pool,
  userId: string
): Promise<MerchantMembershipView[]> {
  const result = await pool.query<MerchantRow & { role: MerchantRole }>(
    `select m.*, mm.role
     from merchant_members mm
     join merchants m on m.id = mm.merchant_id
     where mm.user_id = $1
     order by mm.created_at`,
    [userId]
  );
  return result.rows.map((row) => ({ ...toMerchant(row), yourRole: row.role }));
}

export async function getMerchantForMember(
  pool: Pool,
  userId: string,
  merchantId: string
): Promise<MerchantMembershipView> {
  const { merchant, role } = await requireMembership(pool, merchantId, userId);
  return { ...merchant, yourRole: role };
}

/** What the shop is holding. Derived from the ledger, never stored. */
export async function getMerchantBalance(
  pool: Pool,
  userId: string,
  merchantId: string
): Promise<{ accountId: string; balanceMinorUnits: MinorUnits; currency: "GBP" }> {
  await requireMembership(pool, merchantId, userId);
  const account = await getOrCreateAccountForOwner(pool, "merchant", merchantId);
  const balanceMinorUnits = await getBalanceMinorUnits(pool, account.id);
  return { accountId: account.id, balanceMinorUnits, currency: "GBP" };
}

export async function listMerchantMembers(
  pool: Pool,
  userId: string,
  merchantId: string
): Promise<MerchantMemberView[]> {
  await requireMembership(pool, merchantId, userId);
  const result = await pool.query<{
    user_id: string;
    email: string;
    role: MerchantRole;
    created_at: Date;
  }>(
    `select mm.user_id, u.email, mm.role, mm.created_at
     from merchant_members mm
     join users u on u.id = mm.user_id
     where mm.merchant_id = $1
     order by mm.created_at`,
    [merchantId]
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    displayName: row.email,
    role: row.role,
    isYou: row.user_id === userId,
    addedAt: row.created_at.toISOString(),
  }));
}

/** Owners can bring in staff, or another owner. */
export async function addMerchantMember(
  pool: Pool,
  actorUserId: string,
  merchantId: string,
  input: { email: string; role: MerchantRole }
): Promise<MerchantMemberView> {
  await requireMembership(pool, merchantId, actorUserId, { role: "owner" });
  const user = await findUserByEmail(pool, input.email.trim());
  if (!user) {
    // Same wording as Phase 7: "no such person" shouldn't be a way to
    // find out who has an account.
    throw new MerchantError(
      "MERCHANT_MEMBER_INVALID",
      400,
      "We couldn't add that person to this shop"
    );
  }
  const existing = await getMembership(pool, merchantId, user.id);
  if (existing) {
    throw new MerchantError(
      "MERCHANT_MEMBER_EXISTS",
      409,
      "That person is already part of this shop"
    );
  }
  const result = await pool.query<{ created_at: Date }>(
    `insert into merchant_members (merchant_id, user_id, role, added_by_user_id)
     values ($1, $2, $3, $4)
     returning created_at`,
    [merchantId, user.id, input.role, actorUserId]
  );
  await recordAuditEvent(pool, {
    eventType: "MERCHANT_MEMBER_ADDED",
    actorUserId,
    metadata: { merchantId, memberUserId: user.id, role: input.role },
  });
  return {
    userId: user.id,
    displayName: user.email,
    role: input.role,
    isYou: false,
    addedAt: result.rows[0].created_at.toISOString(),
  };
}

/** Merchant ids this user can act for — for "can they see this receipt?". */
export async function listMerchantIdsForUser(
  q: Queryable,
  userId: string
): Promise<string[]> {
  const result = await q.query<{ merchant_id: string }>(
    `select merchant_id from merchant_members where user_id = $1`,
    [userId]
  );
  return result.rows.map((r) => r.merchant_id);
}
