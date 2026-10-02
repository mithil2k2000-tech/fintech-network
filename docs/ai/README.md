# The assistant

What it is: a read-only explainer for your own account. You ask a question
in plain words, it answers with figures the API computed, and it points at
the screen where you'd do something about it.

What it is not: anything that decides. It cannot move money, approve a
payment, rate a risk, or change a single row. That isn't a policy written
in a prompt — it's the shape of the code, and this page is the argument.

## The four constraints, and what enforces each one

| Constraint | What enforces it |
| --- | --- |
| Never decides whether money moves | No route on the assistant changes anything, and no function it can reach writes. Its only "action" is a link to a screen the person drives. |
| Never calculates money | Answers are templates with named placeholders. A template containing a digit, `£` or `%` is rejected by `assertNoLooseFigures`. Values are substituted at the end, from integers a domain module returned. |
| Never touches balances or the ledger | `facts.ts` imports read functions only — `getBalanceMinorUnits`, `sumOutgoingPaymentsSince`, `getCashbackSummary`. Nothing that posts a transaction is in scope. |
| Stays auditable | Every question records an `ASSISTANT_QUERY` audit event with the intent, the model, the rule-set version and which figures were quoted. |

## How an answer is made

```
question
  -> classify()        fixed rules decide which question this is
  -> gatherFacts()     reads only what that intent needs, scoped to the asker
  -> figuresFor()      every value the answer may quote, by name
  -> model.draft()     words and links only
  -> validateDraft()   no loose figures, no unknown names, no outside links
  -> renderAnswer()    we substitute the values
  -> audit             intent recorded; question and answer are not
```

Each step can only narrow what the next one may do. Classification happens
*before* any lookup, which is why a model can never widen what gets read
out of the database.

## The model port

`AssistantModel.draft()` receives the question, the intent, the available
figure *names* and the facts. It returns prose plus links. That is the
whole type — there is no field in which a model could return an amount, a
decision, an action or a query.

So a model behind this port can be wrong about wording and nothing else.
If its draft quotes a figure it wasn't given, writes a number of its own,
links outside the app, or says nothing, the draft is thrown away, the
deterministic answer goes out instead, and an `ASSISTANT_DRAFT_REJECTED`
event is filed. Tested in
`test/integration/assistant.integration.test.ts`.

The prototype ships with no model at all: `DeterministicAssistant` writes
fixed wording per intent, and each answer says so in `provenance.model`.

If a language model is ever wired in, two things are mandatory:

1. The facts handed over are **data, not instructions**. A payment purpose
   or a display name was typed by someone else and must never be able to
   redirect the assistant.
2. The draft still goes through `validateDraft`. It is not optional and
   not a nicety; it is the reason the safety argument survives the change.

## What it will answer

Balance (with anything waiting on you), spending over the last thirty
days, cashback earned and tree stage, requests waiting for you, the most
recent payment, and why a payment was flagged — repeating the reasons the
payer was shown at the time, never re-judging the payment, never quoting a
score or a rule id.

It refuses four things by design, each with its own intent so the refusal
is testable: moving money, financial advice, anyone else's account, and a
verdict on whether a particular person is genuine. The scam question gets
what to *do* instead — check on a channel you already had, take the time,
remember that a sent payment can't be pulled back.

## Privacy

The assistant stores nothing. There is no `assistant_messages` table,
because a transcript of what someone asked about their own money is data
nobody needs to keep. The conversation lives in the screen's own state and
goes when you leave it. The audit trail records that a question of a
given kind was asked, and a database sweep asserts that no audit row
contains a question or an answer.

## Limits worth saying out loud

The classifier is regular expressions, so an unusual phrasing gets "I
don't know how to answer that one" rather than a wrong answer — which is
the right way round, but it is not natural language understanding. The
window for "recently" is fixed at thirty days. There is no multi-turn
memory: each question is answered on its own. And the safety guidance is
general advice, not an assessment of a specific payment or person.
