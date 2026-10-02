// Domain module: ledger
// The double-entry ledger is the source of truth for every simulated
// balance (spec §10). This file is the ONLY place allowed to write to
// ledger_accounts / transactions / ledger_entries — every other module
// (identity, payments, and later rewards/etc.) calls the functions
// exported here instead of touching those tables directly. That boundary
// is what lets the tables underneath change later without forcing a
// rewrite of every caller: as long as this module's function signatures
// stay stable, the schema behind them is free to evolve.
import type { Pool, PoolClient } from "pg";
import type { MinorUnits } from "@fintech-network/shared-types";
import type { Queryable } from "../../db.js";

export const MODULE_NAME = "ledger" as const;

export type OwnerType = "user" | "merchant" | "system";
export type EntryDirection = "debit" | "credit";

/**
 * What a ledger transaction represents. Extend this union when a new
 * phase adds a new kind of money movement (refund, cashback, ...) — the
 * database column is free text on purpose, so no migration is needed.
 */
export type TransactionKind = "seed" | "payment" | "adjustment" | "cashback";

export interface LedgerAccount {
  id: string;
  ownerType: OwnerType;
  ownerId: string | null;
  name: string | null;
  currency: "GBP";
}

export interface LedgerEntryInput {
  accountId: string;
  direction: EntryDirection;
  amountMinorUnits: MinorUnits;
}

export interface PostTransactionInput {
  description: string;
  /** Defaults to "adjustment" when omitted. */
  kind?: TransactionKind;
  entries: LedgerEntryInput[];
  /**
   * Accounts that must not end up below zero because of this transaction
   * (e.g. the payer in a payment). They're row-locked while the check and
   * the insert happen, so two concurrent payments can't both spend the
   * same funds. System accounts such as seed_funding are intentionally
   * allowed to go negative and shouldn't be listed here.
   */
  nonNegativeAccountIds?: string[];
}

export interface PostedTransaction {
  transactionId: string;
  entries: LedgerEntryInput[];
}

export class LedgerImbalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerImbalanceError";
  }
}

export class InsufficientFundsError extends Error {
  constructor(
    public readonly accountId: string,
    public readonly balanceMinorUnits: MinorUnits,
    public readonly requiredMinorUnits: MinorUnits
  ) {
    super("Insufficient funds");
    this.name = "InsufficientFundsError";
  }
}

/**
 * Every entry amount must be a positive integer (spec §7: no floats, no
 * negative "reversal by subtraction" — a correction is a new transaction
 * with its own entries in the opposite direction), and debits must equal
 * credits. This is checked here, in application code, because a single
 * row's CHECK constraint can't see its sibling rows.
 */
export function assertBalanced(entries: LedgerEntryInput[]): void {
  if (entries.length < 2) {
    throw new LedgerImbalanceError(
      "A transaction needs at least two entries (one debit, one credit)"
    );
  }
  let debits = 0n;
  let credits = 0n;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountMinorUnits) || entry.amountMinorUnits <= 0) {
      throw new LedgerImbalanceError(
        `amountMinorUnits must be a positive integer, got ${entry.amountMinorUnits}`
      );
    }
    const amount = BigInt(entry.amountMinorUnits);
    if (entry.direction === "debit") debits += amount;
    else credits += amount;
  }
  if (debits !== credits) {
    throw new LedgerImbalanceError(
      `Unbalanced transaction: debits=${debits} credits=${credits}`
    );
  }
}

/** Net effect of a set of entries on one account (credits minus debits). */
export function netChangeFor(entries: LedgerEntryInput[], accountId: string): MinorUnits {
  let net = 0;
  for (const entry of entries) {
    if (entry.accountId !== accountId) continue;
    net += entry.direction === "credit" ? entry.amountMinorUnits : -entry.amountMinorUnits;
  }
  return net;
}

interface AccountRow {
  id: string;
  owner_type: OwnerType;
  owner_id: string | null;
  name: string | null;
  currency: string;
}

function toAccount(row: AccountRow): LedgerAccount {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    name: row.name,
    currency: row.currency as "GBP",
  };
}

/**
 * Idempotent and safe under concurrency: returns the existing account for
 * this owner, or creates it. Two simultaneous callers get the same row.
 */
export async function getOrCreateAccountForOwner(
  q: Queryable,
  ownerType: Exclude<OwnerType, "system">,
  ownerId: string
): Promise<LedgerAccount> {
  await q.query(
    `insert into ledger_accounts (owner_type, owner_id, currency)
     values ($1, $2, 'GBP')
     on conflict (owner_type, owner_id) where owner_id is not null do nothing`,
    [ownerType, ownerId]
  );
  const result = await q.query<AccountRow>(
    `select id, owner_type, owner_id, name, currency from ledger_accounts
     where owner_type = $1 and owner_id = $2`,
    [ownerType, ownerId]
  );
  return toAccount(result.rows[0]);
}

/**
 * System accounts (e.g. "seed_funding", later "cashback_reserve") are
 * looked up by name and created on first use. There is no route or
 * external API to create these — only the ledger module itself does.
 */
export async function getOrCreateSystemAccount(
  q: Queryable,
  name: string
): Promise<LedgerAccount> {
  await q.query(
    `insert into ledger_accounts (owner_type, owner_id, name, currency)
     values ('system', null, $1, 'GBP')
     on conflict (name) where owner_type = 'system' do nothing`,
    [name]
  );
  const result = await q.query<AccountRow>(
    `select id, owner_type, owner_id, name, currency from ledger_accounts
     where owner_type = 'system' and name = $1`,
    [name]
  );
  return toAccount(result.rows[0]);
}

/**
 * Posts one transaction using a client that the CALLER has already put
 * inside BEGIN. Use this when the ledger posting must commit or roll back
 * together with the caller's own writes (e.g. a payment moving to
 * COMPLETED). Throws before writing anything if the entries don't balance
 * or a guarded account would go negative.
 */
export async function postTransactionWithClient(
  client: PoolClient,
  input: PostTransactionInput
): Promise<PostedTransaction> {
  assertBalanced(input.entries);

  // Lock in a fixed order so two transactions touching the same accounts
  // can't deadlock each other.
  const guarded = [...new Set(input.nonNegativeAccountIds ?? [])].sort();
  if (guarded.length > 0) {
    await client.query(
      `select id from ledger_accounts where id = any($1::uuid[]) order by id for update`,
      [guarded]
    );
    for (const accountId of guarded) {
      const balance = await getBalanceMinorUnits(client, accountId);
      const net = netChangeFor(input.entries, accountId);
      if (balance + net < 0) {
        throw new InsufficientFundsError(accountId, balance, -net);
      }
    }
  }

  const txResult = await client.query<{ id: string }>(
    `insert into transactions (description, kind) values ($1, $2) returning id`,
    [input.description, input.kind ?? "adjustment"]
  );
  const transactionId = txResult.rows[0].id;

  for (const entry of input.entries) {
    await client.query(
      `insert into ledger_entries (transaction_id, account_id, direction, amount_minor_units)
       values ($1, $2, $3, $4)`,
      [transactionId, entry.accountId, entry.direction, entry.amountMinorUnits]
    );
  }

  return { transactionId, entries: input.entries };
}

/**
 * Posts one transaction atomically in its own database transaction.
 */
export async function postTransaction(
  pool: Pool,
  input: PostTransactionInput
): Promise<PostedTransaction> {
  // Validate before borrowing a connection at all.
  assertBalanced(input.entries);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const posted = await postTransactionWithClient(client, input);
    await client.query("COMMIT");
    return posted;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Prototype-only starting balance for every new consumer account, matching
// the "Alex, Balance £500.00" example in the spec (§42.2 Simulated
// Financial Accounts). Funded from a system account so the books always
// balance — nothing here creates money from nothing without an entry on
// both sides.
const DEMO_SEED_BALANCE_MINOR_UNITS = 50_000; // £500.00

/**
 * Gives a freshly-registered user their starting simulated balance.
 * Callers (identity module, on registration) don't need to know the
 * amount, the system account name, or which side is debit/credit — that's
 * exactly the kind of detail this module boundary exists to hide.
 */
export async function seedDemoBalance(
  pool: Pool,
  userId: string
): Promise<PostedTransaction> {
  const userAccount = await getOrCreateAccountForOwner(pool, "user", userId);
  const seedAccount = await getOrCreateSystemAccount(pool, "seed_funding");

  return postTransaction(pool, {
    description: "Prototype starting balance",
    kind: "seed",
    entries: [
      {
        accountId: seedAccount.id,
        direction: "debit",
        amountMinorUnits: DEMO_SEED_BALANCE_MINOR_UNITS,
      },
      {
        accountId: userAccount.id,
        direction: "credit",
        amountMinorUnits: DEMO_SEED_BALANCE_MINOR_UNITS,
      },
    ],
  });
}

/**
 * Balance = sum(credits) - sum(debits) on this account, matching the
 * "Alice debit, merchant credit" convention used throughout the spec.
 * Always derived from ledger_entries — never a stored/cached column.
 */
export async function getBalanceMinorUnits(
  q: Queryable,
  accountId: string
): Promise<MinorUnits> {
  const result = await q.query<{ balance: string }>(
    `select
       coalesce(sum(amount_minor_units) filter (where direction = 'credit'), 0)
       - coalesce(sum(amount_minor_units) filter (where direction = 'debit'), 0)
       as balance
     from ledger_entries
     where account_id = $1`,
    [accountId]
  );
  return Number(result.rows[0].balance);
}

export interface AccountHistoryEntry {
  entryId: string;
  transactionId: string;
  transactionKind: TransactionKind;
  description: string;
  direction: EntryDirection;
  amountMinorUnits: MinorUnits;
  /** This account's balance immediately after this entry. */
  balanceAfterMinorUnits: MinorUnits;
  occurredAt: string;
}

export interface HistoryCursor {
  occurredAt: string;
  entryId: string;
}

/**
 * One account's entries, newest first, each with the running balance
 * after it. Keyset-paginated: pass the last item's (occurredAt, entryId)
 * as `before` to get the next page. The running balance is computed over
 * the account's full history, so it's correct on every page.
 */
export async function listAccountHistory(
  q: Queryable,
  accountId: string,
  options: { limit: number; before?: HistoryCursor }
): Promise<AccountHistoryEntry[]> {
  const result = await q.query<{
    id: string;
    transaction_id: string;
    kind: TransactionKind;
    description: string;
    direction: EntryDirection;
    amount_minor_units: string;
    balance_after: string;
    created_at: Date;
  }>(
    `with history as (
       select
         le.id, le.transaction_id, t.kind, t.description, le.direction,
         le.amount_minor_units, le.created_at,
         sum(case when le.direction = 'credit' then le.amount_minor_units
                  else -le.amount_minor_units end)
           over (order by le.created_at, le.id) as balance_after
       from ledger_entries le
       join transactions t on t.id = le.transaction_id
       where le.account_id = $1
     )
     select * from history
     where $2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::uuid)
     order by created_at desc, id desc
     limit $4`,
    [
      accountId,
      options.before?.occurredAt ?? null,
      options.before?.entryId ?? null,
      options.limit,
    ]
  );
  return result.rows.map((row) => ({
    entryId: row.id,
    transactionId: row.transaction_id,
    transactionKind: row.kind,
    description: row.description,
    direction: row.direction,
    amountMinorUnits: Number(row.amount_minor_units),
    balanceAfterMinorUnits: Number(row.balance_after),
    occurredAt: row.created_at.toISOString(),
  }));
}

/**
 * The books, checked rather than asserted (Phase 15). Every transaction
 * must have equal debits and credits and no account an owner holds may
 * be negative — the two invariants this ledger exists to keep. They are
 * checked in the database, live, because an operations view that
 * reports "all fine" from a cached number reports nothing.
 */
export async function checkLedgerIntegrity(q: Queryable): Promise<{
  unbalancedTransactions: number;
  negativeOwnerAccounts: number;
  entries: number;
}> {
  const result = await q.query<{ unbalanced: string; negative: string; entries: string }>(
    `select
       (select count(*)::text from (
          select transaction_id from ledger_entries
          group by transaction_id
          having coalesce(sum(amount_minor_units) filter (where direction = 'debit'), 0)
              <> coalesce(sum(amount_minor_units) filter (where direction = 'credit'), 0)
        ) x) as unbalanced,
       (select count(*)::text from (
          select a.id from ledger_accounts a
          join ledger_entries e on e.account_id = a.id
          where a.owner_type <> 'system'
          group by a.id
          having coalesce(sum(amount_minor_units) filter (where direction = 'credit'), 0)
               - coalesce(sum(amount_minor_units) filter (where direction = 'debit'), 0) < 0
        ) y) as negative,
       (select count(*)::text from ledger_entries) as entries`
  );
  const row = result.rows[0];
  return {
    unbalancedTransactions: Number(row.unbalanced),
    negativeOwnerAccounts: Number(row.negative),
    entries: Number(row.entries),
  };
}
