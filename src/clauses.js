// Clause segmentation and candidate retrieval.
//
// Everything in this file is arithmetic. No model is consulted here, and that
// is the point: the model is never the thing that decides which parts of your
// contract are about side income. It only ever sees clauses that keyword
// retrieval already put in front of it.

/** Categories of clause that decide whether you can sell what you build. */
export const CATEGORIES = [
  {
    id: 'outside_work',
    label: 'Outside work',
    // The clause that says whether a side hustle is allowed at all.
    anchors: [
      'outside employment', 'outside work', 'other employment', 'secondary employment',
      'dual employment', 'moonlight', 'moonlighting', 'other business', 'second job',
      'any other engagement', 'gainful employment', 'additional employment',
    ],
    terms: ['consent', 'permission', 'written approval', 'prior approval', 'engage in', 'undertake', 'shall not'],
  },
  {
    id: 'ip_assignment',
    label: 'Inventions and IP',
    // The clause that decides who owns the thing you built on a Sunday.
    anchors: [
      'intellectual property', 'inventions', 'work product', 'works made for hire',
      'assigns to the company', 'assign to the company', 'vest in the company',
      'proprietary rights', 'copyright', 'patent',
    ],
    terms: ['conceived', 'developed', 'created', 'whether or not', 'during the term', 'sole property', 'exclusive property'],
  },
  {
    id: 'exclusivity',
    label: 'Exclusivity of time',
    // "Whole of your time" clauses: not a ban on paid work, a claim on hours.
    anchors: [
      'whole of your time', 'entire working time', 'full time and attention',
      'best efforts', 'devote your full', 'devote the whole', 'full working time',
      'exclusive service', 'exclusively for the company',
    ],
    terms: ['attention', 'devote', 'working hours', 'business hours'],
  },
  {
    id: 'non_compete',
    label: 'Non-compete',
    anchors: [
      'non-compete', 'noncompete', 'not compete', 'competing business',
      'competitive business', 'restraint of trade', 'similar business',
    ],
    terms: ['period of', 'months', 'years', 'territory', 'after termination', 'cease'],
  },
  {
    id: 'non_solicit',
    label: 'Clients and non-solicitation',
    // Matters if your first customer is also your employer's customer.
    anchors: [
      'non-solicitation', 'not solicit', 'solicit any client', 'solicit any customer',
      'entice away', 'poach',
    ],
    terms: ['client', 'customer', 'employee', 'after termination'],
  },
  {
    id: 'confidentiality',
    label: 'Confidential information',
    anchors: [
      'confidential information', 'confidentiality', 'trade secret',
      'non-disclosure', 'proprietary information',
    ],
    terms: ['disclose', 'shall not use', 'third party', 'survive'],
  },
  {
    id: 'disclosure_duty',
    label: 'Duty to disclose',
    // The clause that turns "I just didn't mention it" into a breach.
    anchors: [
      'conflict of interest', 'shall disclose', 'must disclose', 'notify the company',
      'inform the company', 'declare any', 'disclosure of interest',
      'promptly disclose', 'disclose to the company', 'may conflict with',
      'conflicts or may conflict',
    ],
    terms: ['promptly', 'in writing', 'interest', 'arises'],
  },
];

const MIN_CLAUSE_CHARS = 40;

// A clause starts at a line beginning with 1., 1.1, 1.1.1, or Article N.
const NUMBERED = /^\s{0,8}(?:(?:article|clause|section)\s+)?(\d+(?:\.\d+){0,3})[.)]?\s+\S/i;
// A heading is a short line in capitals, optionally numbered.
const HEADING = /^\s{0,8}(?:(?:article|clause|section)\s+)?(\d+(?:\.\d+){0,3})?[.)]?\s*([A-Z][A-Z\s\-&/',()]{3,70})\s*$/;

/**
 * Split a contract into numbered clauses.
 *
 * Real contracts are numbered ("9.", "9.2", "14.1") and sectioned with
 * headings. We anchor on the numbering because it is the one structural
 * convention nearly every employment contract follows, and fall back to
 * paragraph splitting when a document has no numbering at all.
 */
export function segment(text) {
  const normalised = String(text || '').replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');

  const starts = [];
  const headingAt = new Map();
  let currentHeading = '';

  lines.forEach((line, i) => {
    const h = line.match(HEADING);
    if (h && h[2] && h[2].trim().split(/\s+/).length <= 9) {
      currentHeading = h[2].trim().replace(/\s+/g, ' ');
    }
    if (NUMBERED.test(line)) {
      starts.push(i);
      headingAt.set(i, currentHeading);
    }
  });

  let clauses;
  if (starts.length >= 3) {
    clauses = starts.map((start, idx) => {
      const end = idx + 1 < starts.length ? starts[idx + 1] : lines.length;
      const body = lines.slice(start, end).join('\n').trim();
      const num = (lines[start].match(NUMBERED) || [])[1] || String(idx + 1);
      return { number: num, heading: headingAt.get(start) || '', text: body };
    });
  } else {
    // No numbering to lean on. Fall back to blank-line paragraphs.
    clauses = normalised
      .split(/\n\s*\n/)
      .map((body, idx) => ({ number: String(idx + 1), heading: '', text: body.trim() }));
  }

  return clauses
    .filter((c) => c.text.length >= MIN_CLAUSE_CHARS)
    .map((c, i) => ({ id: `c${i + 1}`, ...c }));
}

/** Normalise text for comparison: lowercase, collapse whitespace, unify quotes and dashes. */
export function normalise(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score one clause against one category.
 *
 * An anchor is a phrase that only appears in clauses of that kind. A term is
 * supporting vocabulary. A clause needs an anchor to be a candidate at all:
 * supporting vocabulary on its own ("shall not", "in writing") appears
 * everywhere in a contract and would drag in half the document.
 */
export function score(clauseText, category) {
  const hay = normalise(clauseText);
  const anchors = category.anchors.filter((a) => hay.includes(normalise(a)));
  if (anchors.length === 0) return null;
  const terms = category.terms.filter((t) => hay.includes(normalise(t)));
  return { anchors, terms, points: anchors.length * 2 + terms.length };
}

/**
 * Find the clauses worth asking about, in code, before any model runs.
 *
 * Returns one entry per (clause, category) hit, strongest first. A clause that
 * matches two categories is asked about twice, because "you must disclose
 * outside work" and "we own what you invent" are different questions even when
 * they live in the same paragraph.
 */
export function findCandidates(text, { limit = 12 } = {}) {
  const clauses = segment(text);
  const hits = [];
  for (const clause of clauses) {
    // The section heading is scored along with the body. "7.1 The Employee
    // shall promptly disclose ... any interest which conflicts" never says the
    // phrase "conflict of interest" — the heading above it does, and dropping
    // that signal loses the clause entirely.
    const haystack = `${clause.heading}\n${clause.text}`;
    for (const category of CATEGORIES) {
      const s = score(haystack, category);
      if (s) hits.push({ clause, category, ...s });
    }
  }
  hits.sort((a, b) => b.points - a.points || a.clause.id.localeCompare(b.clause.id));
  return { clauses, candidates: hits.slice(0, limit), totalHits: hits.length };
}
