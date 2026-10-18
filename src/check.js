// Self-test. Run with: npm run check
//
// The interesting tests are the ones that try to break the safety property
// rather than confirm it. A gate you have never seen reject anything is not a
// gate you know works.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATEGORIES, findCandidates, segment } from './clauses.js';
import { detect } from './flags.js';
import { health } from './gemma.js';
import { review, stripVerdicts, verifyQuote } from './review.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const contract = await readFile(join(root, 'data', 'sample-contract.txt'), 'utf8');

console.log('\nSegmentation');
const clauses = segment(contract);
ok('finds clauses in a numbered contract', clauses.length >= 20, `got ${clauses.length}`);
ok('keeps clause numbers', clauses.some((c) => c.number === '9.2'));
ok('carries section headings', clauses.some((c) => /INTELLECTUAL PROPERTY/i.test(c.heading)));
ok('drops fragments shorter than a sentence', clauses.every((c) => c.text.length >= 40));

const noNumbers = 'The employee shall not engage in any other employment without consent.\n\nAll inventions conceived during employment are the property of the company and the employee assigns all copyright in them.\n\nThe employee shall keep confidential information confidential at all times and shall not disclose it to any third party.';
ok('falls back to paragraphs when nothing is numbered', segment(noNumbers).length === 3, `got ${segment(noNumbers).length}`);

console.log('\nRetrieval (arithmetic, no model)');
const { candidates, totalHits } = findCandidates(contract, { limit: 20 });
const cats = new Set(candidates.map((c) => c.category.id));
ok('finds the outside-work clause', cats.has('outside_work'));
ok('finds the IP assignment clause', cats.has('ip_assignment'));
ok('finds the whole-of-your-time clause', cats.has('exclusivity'));
ok('finds confidentiality', cats.has('confidentiality'));
ok('finds the duty to disclose', cats.has('disclosure_duty'));
ok('finds non-solicitation', cats.has('non_solicit'));
ok('reports no non-compete, because there is none', !cats.has('non_compete'));
ok('does not drag in the whole document', totalHits < clauses.length, `${totalHits} hits over ${clauses.length} clauses`);
ok('never matches on supporting vocabulary alone', candidates.every((c) => c.anchors.length > 0));

const leave = clauses.find((c) => c.number === '13.1');
ok('ignores a clause about annual leave', CATEGORIES.every((cat) => {
  const hay = leave.text.toLowerCase();
  return !cat.anchors.some((a) => hay.includes(a.toLowerCase()));
}));

console.log('\nThe hallucination gate');
const ip = clauses.find((c) => c.number === '9.2');

// The real sentence, copied out of the document.
const real = 'whether or not during working hours, whether or not using the resources of the Company';
ok('accepts a sentence that is in the document', verifyQuote(real, ip.text).ok);

// Whitespace is normalised, because the model reflows line breaks.
ok('accepts the same sentence reflowed', verifyQuote(real.replace(/ /g, '\n  '), ip.text).ok);

// The dangerous case. This is what a paraphrase looks like: it reads like the
// clause, it is about the clause, and it is not the clause. It says "relating
// to" where the contract says "whether or not relating to" — the opposite.
const paraphrase = 'All works created by the employee relating to the business of the Company shall be the property of the Company.';
const rejected = verifyQuote(paraphrase, ip.text);
ok('rejects a plausible paraphrase', !rejected.ok && rejected.reason === 'not-in-document', JSON.stringify(rejected));

ok('rejects a quote too short to be evidence', !verifyQuote('the Company', ip.text).ok);
ok('rejects an elided quote', !verifyQuote('all Works conceived, created ... property of the Company', ip.text).ok);
ok('rejects nothing at all', !verifyQuote('', ip.text).ok);

console.log('\nFlags (code, not inference)');
const ipFlags = detect(clauses.find((c) => c.number === '9.2').text);
const ipIds = ipFlags.flags.map((f) => f.id);
ok('IP clause: transfers ownership', ipIds.includes('assigns_ownership'));
ok('IP clause: reaches past working hours', ipIds.includes('beyond_working_hours'));
ok('IP clause: applies even if unrelated', ipIds.includes('regardless_of_relevance'));
ok('IP clause: applies on your own equipment', ipIds.includes('regardless_of_resources'));

const outsideFlags = detect(clauses.find((c) => c.number === '6.1').text);
const outIds = outsideFlags.flags.map((f) => f.id);
ok('outside-work clause: is a permission, not a ban', outIds.includes('requires_consent'));
ok('every flag cites the words that set it off', outsideFlags.flags.every((f) => f.evidence.length > 0));
ok('consent evidence names the consent', /consent/i.test(outsideFlags.flags.find((f) => f.id === 'requires_consent')?.evidence || ''));

const solicitFlags = detect(clauses.find((c) => c.number === '11.1').text);
ok('non-solicit clause: outlives the job', solicitFlags.flags.some((f) => f.id === 'survives_termination'));
ok('non-solicit clause: picks up the twelve-month period', solicitFlags.duration === '12 months', String(solicitFlags.duration));

ok('a leave clause raises no flags', detect(leave.text).flags.length === 0, JSON.stringify(detect(leave.text).flags));
ok('a notice clause raises no flags', detect(clauses.find((c) => c.number === '14.1').text).flags.length === 0);

console.log('\nVerdict suppression');
ok('strips a legal conclusion', stripVerdicts('This means you may not run a side business.').removed);
ok('strips an enforceability claim', stripVerdicts('Such a clause is unenforceable in India.').removed);
ok('strips advice', stripVerdicts('I recommend asking HR first.').removed);
ok('keeps a plain description', !stripVerdicts('The clause requires written consent before other employment.').removed);

console.log('\nLive model');
const h = await health();
if (!h.up) {
  console.log(`  SKIP  model not running (${h.reason}). Start it with: ollama serve`);
} else if (!h.installed) {
  console.log(`  SKIP  ${h.model} not installed. Run: ollama pull ${h.model}`);
} else {
  const result = await review(contract, { limit: 8 });
  console.log(`        ${JSON.stringify(result.stats)}`);
  ok('read at least one clause end to end', result.stats.read >= 1);
  ok('every shown quote is in the document', result.findings
    .filter((f) => f.state === 'read')
    .every((f) => verifyQuote(f.quote, f.text).ok));
  ok('no finding carries a verdict', result.findings.every((f) => !f.effectStripped || f.effect === ''));

  for (const f of result.findings.filter((x) => x.state === 'read')) {
    console.log(`\n  ${f.categoryLabel} — clause ${f.number}  [${f.flags.map((x) => x.id).join(', ') || 'no flags'}]`);
    console.log(`    "${f.quote.replace(/\s+/g, ' ').slice(0, 150)}"`);
    if (f.effect) console.log(`    ${f.effect}`);
    if (f.question) console.log(`    Ask: ${f.question}`);
  }
  for (const f of result.findings.filter((x) => x.state !== 'read')) {
    console.log(`\n  [discarded: ${f.reason}] ${f.categoryLabel} — clause ${f.number}`);
    if (f.discarded) console.log(`    model said: "${f.discarded.replace(/\s+/g, ' ').slice(0, 150)}"`);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
