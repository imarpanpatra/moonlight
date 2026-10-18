// Orchestration, and the rule that matters.

import { CATEGORIES, findCandidates, normalise } from './clauses.js';
import { detect } from './flags.js';
import { ask, buildPrompt } from './gemma.js';

/** A quote shorter than this matches too much of any contract to be evidence. */
const MIN_QUOTE_CHARS = 30;

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

  // Kept, but demoted. The eval put this at 7/14, with "yes" for 13 of 14
  // clauses, so it is recorded for ordering and never shown as a conclusion.
  const modelGuess = ['yes', 'unclear', 'no'].includes(raw.governs_side_income)
    ? raw.governs_side_income
    : 'unclear';

  return {
    ...base,
    state: 'read',
    modelGuess,
    quote: String(raw.quote).trim(),
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
  const { clauses, candidates, totalHits } = findCandidates(text, { limit });

  const findings = [];
  for (let i = 0; i < candidates.length; i += 1) {
    if (onProgress) onProgress({ done: i, total: candidates.length });
    findings.push(await readOne(candidates[i]));
  }

  // Order by what the clause does, not by what the model thought of it.
  findings.sort((a, b) => weigh(b) - weigh(a) || a.number.localeCompare(b.number));

  const seen = new Set(findings.map((f) => f.category));
  const absent = CATEGORIES
    .filter((c) => !seen.has(c.id))
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
      verdicts: 0, // By construction. See stripVerdicts.
      ms: Date.now() - started,
    },
    findings,
    absent,
  };
}
