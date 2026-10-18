// Orchestration, and the rule that matters.

import { CATEGORIES, compareClauseNumbers, findCandidates, normalise } from './clauses.js';
import { detect } from './flags.js';
import { ask, buildPrompt } from './gemma.js';

/** A quote shorter than this matches too much of any contract to be evidence. */
const MIN_QUOTE_CHARS = 30;

/** At ~5 seconds a clause, this is already a minute and a half of waiting. */
const MAX_CANDIDATES = 40;

const VERDICT_WORDS = [
  'you may', 'you may not', 'you can', 'you cannot', 'you are allowed',
  'you are not allowed', 'is legal', 'is illegal', 'is enforceable',
  'unenforceable', 'i recommend', 'you should not', 'it is safe', 'it is not safe',
];

/**
 * Did the model actually quote the contract, or did it write a sentence that
 * sounds like the contract?
 *
 * This is the whole safety property. A paraphrase of an IP assignment clause
 * reads exactly like the clause and means something different, and the person
 * reading the output has no way to tell the two apart. So a quote that is not
 * in the document, character for character after whitespace normalisation, is
 * treated as a hallucination and thrown away. The clause is still shown. It is
 * shown raw, unread, and labelled as such.
 */
export function verifyQuote(quote, clauseText) {
  const q = normalise(quote);
  if (!q) return { ok: false, reason: 'empty' };
  if (q.length < MIN_QUOTE_CHARS) return { ok: false, reason: 'too-short' };
  if (q.includes('...') || q.includes('[')) return { ok: false, reason: 'elided' };
  if (!normalise(clauseText).includes(q)) return { ok: false, reason: 'not-in-document' };
  return { ok: true, span: locate(quote, clauseText) };
}

/**
 * Find the model's quote inside the document and return the document's own text.
 *
 * Verification is done on normalised text — lowercased, whitespace collapsed,
 * curly quotes flattened — which is right for checking but wrong for display.
 * A model that returns the clause IN BLOCK CAPITALS, or with straight quotes
 * where the contract has curly ones, passes the check, and then the interface
 * presents its version as a verbatim quotation of the contract. So once a quote
 * is verified, the span is located in the original and the original is what gets
 * shown. What you read on screen is then literally the characters in your file.
 */
function locate(quote, clauseText) {
  const words = normalise(quote).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  // Quote and dash characters differ between the model's copy and the file, so
  // match them as loosely as normalise() flattens them. Words are joined with
  // \s+ because the file is hard-wrapped where the normalised quote has spaces.
  const loose = words
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .map((w) => w
      .replace(/'/g, "['‘’‚‛]")
      .replace(/"/g, '["“”„‟]')
      .replace(/-/g, '[-‐-―−]'))
    .join('\\s+');
  try {
    const m = clauseText.match(new RegExp(loose, 'i'));
    return m ? m[0].replace(/\s+/g, ' ').trim() : null;
  } catch {
    return null; // A quote that will not compile is simply not located.
  }
}

/**
 * Is the model's reply the object we asked for?
 *
 * It is asked for a JSON object with five keys. It can return `null`, a bare
 * string, a number or an array instead, and `raw.quote` on `null` throws a
 * TypeError that escapes readOne, unwinds review(), and loses every clause in
 * the document to one malformed reply. One bad clause should cost one clause.
 */
export function describeResponse(raw) {
  if (raw === null) return { ok: false, reason: 'model returned null, not an object' };
  if (Array.isArray(raw)) return { ok: false, reason: 'model returned an array, not an object' };
  if (typeof raw !== 'object') return { ok: false, reason: `model returned a ${typeof raw}, not an object` };
  return { ok: true };
}

/** Strip any sentence where the model started giving advice anyway. */
export function stripVerdicts(sentence) {
  const s = String(sentence || '').trim();
  if (!s) return { text: '', removed: false };
  const lower = normalise(s);
  const hit = VERDICT_WORDS.find((w) => lower.includes(w));
  return hit ? { text: '', removed: true, word: hit } : { text: s, removed: false };
}

/**
 * How much a clause should demand of your attention, in code.
 *
 * A clause that assigns ownership of anything you make, on your own equipment,
 * whether or not it relates to their business, is the one to read first. A
 * clause that merely requires you to ask permission is the one to read last,
 * because asking is a thing you can actually do.
 */
const FLAG_WEIGHT = {
  assigns_ownership: 5,
  regardless_of_relevance: 4,
  regardless_of_resources: 4,
  beyond_working_hours: 3,
  survives_termination: 3,
  duty_to_disclose: 2,
  requires_consent: 1,
};

function weigh(finding) {
  const base = (finding.flags || []).reduce((n, f) => n + (FLAG_WEIGHT[f.id] || 0), 0);
  // An unverified clause is shown near the top: nobody has read it for you.
  return finding.state === 'read' ? base : base + 2;
}

/** One candidate clause, read by the model, then checked. */
async function readOne({ clause, category, anchors }) {
  // Detected in code, shown whatever the model does or fails to do. These are
  // the properties the reader acts on, so they must not depend on inference.
  const { flags, duration } = detect(clause.text);

  const base = {
    clauseId: clause.id,
    number: clause.number,
    heading: clause.heading,
    category: category.id,
    categoryLabel: category.label,
    matchedOn: anchors,
    flags,
    duration,
    text: clause.text,
  };

  let raw;
  try {
    raw = await ask(buildPrompt({ clause, category }));
  } catch (err) {
    return { ...base, state: 'unread', reason: `model error: ${err.message}` };
  }

  const usable = describeResponse(raw);
  if (!usable.ok) return { ...base, state: 'unread', reason: usable.reason };

  const check = verifyQuote(raw.quote, clause.text);
  if (!check.ok) {
    // The model said something about this clause. We could not confirm it
    // against the document, so we discard what it said and keep the clause.
    return {
      ...base,
      state: 'unverified',
      reason: check.reason,
      discarded: String(raw.quote || '').slice(0, 300),
    };
  }

  const effect = stripVerdicts(raw.effect);

  // Recorded for the eval and for anyone inspecting the JSON, and deliberately
  // used by nothing: not the ordering, not the interface. The eval put it at
  // 7/14, answering "yes" to 13 of 14 clauses.
  const modelGuess = ['yes', 'unclear', 'no'].includes(raw.governs_side_income)
    ? raw.governs_side_income
    : 'unclear';

  return {
    ...base,
    state: 'read',
    modelGuess,
    // The document's own characters where they could be located, the model's
    // string only as a fallback. See locate().
    quote: check.span || String(raw.quote).trim(),
    quoteFromDocument: Boolean(check.span),
    effect: effect.text,
    effectStripped: effect.removed,
    // From the clause text, not from the model's requires_consent field.
    requiresConsent: flags.some((f) => f.id === 'requires_consent'),
    question: stripVerdicts(raw.question).text,
  };
}

/**
 * Review a contract.
 *
 * Retrieval is arithmetic, reading is the model, and every reading is checked
 * against the document before it is shown. Categories with no clause at all
 * are reported as absent, because "there is no non-compete in this document"
 * is one of the more useful things this can tell you.
 */
export async function review(text, { limit = 12, onProgress } = {}) {
  const started = Date.now();
  // Clamped. The limit reaches this from an HTTP body, and a negative one made
  // slice(0, -5) quietly discard the last five candidates, while a huge one
  // would queue thousands of model calls at five seconds each.
  const capped = Math.min(Math.max(Math.trunc(Number(limit) || 12), 1), MAX_CANDIDATES);
  const { clauses, candidates, totalHits, present } = findCandidates(text, { limit: capped });

  const findings = [];
  for (let i = 0; i < candidates.length; i += 1) {
    if (onProgress) onProgress({ done: i, total: candidates.length });
    findings.push(await readOne(candidates[i]));
  }

  // Order by what the clause does, not by what the model thought of it.
  findings.sort((a, b) => weigh(b) - weigh(a) || compareClauseNumbers(a.number, b.number));

  // Absent means absent from the whole document, not merely from the clauses
  // that fitted under the limit. `present` is computed before the cap.
  const absent = CATEGORIES
    .filter((c) => !present.has(c.id))
    .map((c) => ({ category: c.id, categoryLabel: c.label }));

  return {
    stats: {
      clauses: clauses.length,
      candidates: candidates.length,
      totalHits,
      read: findings.filter((f) => f.state === 'read').length,
      unverified: findings.filter((f) => f.state === 'unverified').length,
      unread: findings.filter((f) => f.state === 'unread').length,
      flagged: findings.filter((f) => f.flags.length > 0).length,
      // Matches that were found but not read, because the limit cut them off.
      // Shown, rather than quietly dropped.
      skipped: Math.max(0, totalHits - candidates.length),
      verdicts: 0, // By construction. See stripVerdicts.
      ms: Date.now() - started,
    },
    findings,
    absent,
  };
}
