# Moonlight

**Before you sell anything, read the contract you already signed.**

Every tool built for side hustlers helps you *run* one: sort the receipts, write
the listing, chase the invoice, price the job. None of them check the document
that decides whether you are allowed to have one at all.

Most people with a side hustle have a day job. The contract they signed for that
day job contains three or four clauses that govern everything they build on a
Sunday — who owns it, whether they needed permission first, whether they were
obliged to mention it. Those clauses are written to be skimmed past.

Moonlight finds them, quotes them, and tells you what to ask.

Built for the
[Hacktoberfest Open-Source AI Challenge, Week 2: Side Hustle](https://dev.to/challenges/hacktoberfest-week2-2026-10-12).

---

## Why this one has to be local

This is the least uploadable document a person owns.

A freelancer can paste a client contract into a cloud model and risk a scolding.
Pasting *your own employment agreement* into someone else's API means handing a
third party your salary, your notice period, your employer's name and the exact
clauses you are quietly worried about — in order to ask a question you do not
want your employer to know you asked.

There is no version of this product that runs on a hosted API. Open weights are
not a cost optimisation here. They are the only reason the thing can exist.

So the promise is checkable, not rhetorical:

```
$ npm run airgap

Reviewing the sample contract with all sockets instrumented…

Clauses read: 6, discarded: 0

Outbound connections observed: 7
    7 x  tcp 127.0.0.1:11434

DNS lookups observed: 0

PASS — every connection was to loopback. The contract never left this machine.
```

`src/airgap.js` monkey-patches `net.Socket.prototype.connect`, `tls.connect` and
`dns.lookup` before the app is imported, runs a full review, and fails if
anything addresses a host that is not loopback. A DNS lookup alone counts as a
leak, because it tells a resolver you are here.

---

## The rule that matters

**The model quotes. It never concludes.**

A 4B model asked "can I run a side business under this clause?" will answer, it
will sound certain, and when it is wrong someone loses their job. So it is never
asked. Its entire job is to find the operative sentence and copy it out.

Then the copy is checked:

```js
if (!normalise(clauseText).includes(normalise(quote))) {
  // not in the document — discard the reading, keep the clause
}
```

A quote that is not in your contract, character for character after whitespace
normalisation, is treated as a hallucination rather than a summary. The clause
is still shown — raw, unread, and labelled *located, not read*.

This matters more than it sounds. A paraphrase of a contract clause reads
exactly like the clause and can mean the opposite, and the person reading it has
no way to tell. See [What the 1B model did](#what-the-1b-model-did).

---

## What it tells you, and where that comes from

| Output | Produced by | Checkable? |
| --- | --- | --- |
| Which clauses are relevant | Keyword retrieval (`src/clauses.js`) | Yes — it shows the phrase it matched |
| The operative sentence | gemma3:4b, then verified against the document | Yes — it is in your contract or it is not shown |
| What the clause does (flags) | Pattern matching (`src/flags.js`) | Yes — each flag quotes the words that triggered it |
| Ordering | Flag weights, in code | Yes |
| Whether you may do it | **Nothing. It does not answer this.** | — |

The flags are the part a reader acts on:

- **Asks permission, not a ban** — *"without the prior written consent of the Company"*
- **Outlives the job** — *"at any time after its termination"*
- **Reaches past working hours** — *"whether or not during working hours"*
- **Applies even if unrelated** — *"whether or not relating to the present business of the Company"*
- **Applies on your own equipment** — *"whether or not using the resources of the Company"*
- **Transfers ownership** — *"hereby assigns to the Company all right"*
- **You must tell them** — *"shall promptly disclose to the Company in writing any interest"*

Each one is a regex over the clause text, and each shows its evidence, so a
wrong flag is wrong visibly.

---

## Why the model does not get to judge

It was going to. The first build asked gemma3:4b to classify each clause as
`yes` / `unclear` / `no` — does this reach outside the job. It answered
`unclear` for all 8 clauses in the sample contract.

Rewriting the prompt with sharper definitions flipped it: now it answered `yes`
for all 8. Same model, same contract, same temperature, opposite output. That
is not a judgement, it is a coin that lands on whichever side the prompt tilts.

So it got measured instead. `src/eval.js` is 14 labelled clauses — 6 that reach
outside the job, 5 that cannot, 3 that genuinely read both ways:

```
$ node src/eval.js

Model: gemma3:4b   cases: 14

Classification:   7/14  (50%)
Quotes verbatim: 14/14  (100%)
Time: 72.4s total, 5.2s per clause

Confusion:
  6 x  yes -> yes
  4 x  no -> yes
  3 x  unclear -> yes
  1 x  no -> no

Binding clauses called harmless ("yes" -> "no"): 0
```

Read that as two separate findings.

**The model cannot judge.** 50%, and it answered `yes` to 13 of 14 clauses. It
flags your annual leave clause as governing your side income.

**The model can extract, perfectly.** 14/14 verbatim quotes. Not one
paraphrase, not one invented sentence, across every clause type.

So the classification was deleted from the product and the extraction was kept.
`src/flags.js` exists because of that eval.

The one consolation in the error profile: **zero `yes -> no` errors.** It never
called a binding clause harmless. For this tool that is the right asymmetry —
over-flagging costs you ten minutes of reading, under-flagging costs you the
rights to your own project.

---

## What the 1B model did

Open weights mean you can swap the model with an environment variable, so the
same eval ran on gemma3:1b. It is 815 MB against 3.3 GB, and 15% faster.

```
Model: gemma3:1b   cases: 14

Classification:   6/14  (43%)
Quotes verbatim:  0/14  (0%)
```

Zero. Two distinct failures, both real:

**On long clauses it abandons the schema.** Asked for five keys, it returns one
and stops:

```json
{"governs_side_income":"yes"}
```

Eleven tokens, `done_reason: stop`. No quote at all, so the gate records the
clause as *located, not read* and shows it to you raw. Degraded, but safe.

**On short clauses it quotes something that is not there.** Given clause 6.1, it
produced:

> "The Employee shall not engage in any other employment, consultancy, trade or
> business, whether or not for remuneration"

The contract says:

> "the Employee shall not, **without the prior written consent of the Company**,
> engage in any other employment, consultancy, trade or business"

It deleted *without the prior written consent of the Company*. That edit turns a
permission you can go and ask for into an absolute prohibition. A person reading
that would conclude their side hustle is forbidden and quietly abandon it, when
the actual clause says: fill in a form.

The verbatim gate rejected it, because those words are not in the document.
That is the single best argument for the rule, and I did not have to invent the
example — a 1B model produced it on the first clause I tested.

---

## Running it

Requires [Ollama](https://ollama.com) and Node 20+.

```bash
ollama pull gemma3:4b
ollama serve

npm install
npm start           # http://127.0.0.1:4455
```

Then paste a contract, or press **Use the sample contract** for the fictional one
in `data/sample-contract.txt`.

```bash
npm run check       # 39 tests: segmentation, retrieval, the gate, the flags
npm run airgap      # proves nothing leaves the machine
node src/eval.js    # the 14-clause labelled eval

MOONLIGHT_MODEL=gemma3:1b node src/eval.js   # try it on the 1B model
```

On an RTX 3050 (4 GB) a 28-clause contract takes about 90 seconds end to end,
roughly 5 seconds per clause. It is not fast. It is a document you read once.

---

## How it is put together

```
contract text
     │
     ├─ segment()        split on clause numbering, carry section headings
     │
     ├─ findCandidates() keyword retrieval, anchors required        ← arithmetic
     │                   28 clauses → 12 candidates
     │
     ├─ detect()         pattern flags, each citing its evidence    ← arithmetic
     │
     ├─ ask()            gemma3:4b: quote the operative sentence    ← the model
     │
     ├─ verifyQuote()    in the document, or discarded              ← the gate
     │
     └─ weigh()          order by what the clause does              ← arithmetic
```

The model sees one clause at a time, never the whole contract, and never decides
which clauses matter. Retrieval does that, in code, before any inference runs.

| File | Does |
| --- | --- |
| `src/clauses.js` | Segmentation and keyword retrieval. No model. |
| `src/flags.js` | Deterministic clause properties with evidence. No model. |
| `src/gemma.js` | The only file that opens a socket. The prompt lives here. |
| `src/review.js` | Orchestration, the verbatim gate, verdict stripping, ordering. |
| `src/server.js` | Express, bound to 127.0.0.1. |
| `src/check.js` | 39 tests. |
| `src/eval.js` | 14 labelled clauses. |
| `src/airgap.js` | Socket and DNS instrumentation. |

---

## What it is not

It is not a lawyer, and it does not pretend to be one. It never says whether
something is allowed, enforceable, or advisable — `stripVerdicts()` removes
those sentences if the model produces them anyway.

Retrieval is keyword-based, so a contract that phrases a moonlighting clause in
words I did not anticipate will have that clause missed. "Not found in this
document" is a statement about the retrieval keywords, not a guarantee about
your position, and the UI says so.

The sample contract is fictional, written to exercise the code.

## Licence

MIT.
