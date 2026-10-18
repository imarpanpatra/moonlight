// A small labelled eval, because "it seemed to work" is not a claim.
//
// Run with: node src/eval.js            (gemma3:4b, the default)
//           MOONLIGHT_MODEL=gemma3:1b node src/eval.js
//
// Retrieval is deliberately bypassed here. Each clause goes straight to the
// model with its category, so this measures one thing only: can the model
// tell a clause that reaches outside work from one that cannot?

import { CATEGORIES } from './clauses.js';
import { ask, buildPrompt, health, MODEL } from './gemma.js';
import { verifyQuote } from './review.js';

const cat = (id) => CATEGORIES.find((c) => c.id === id);

/**
 * Labels are mine, and arguable in two places (4.2 and 5.2), which is why
 * those two are labelled "unclear" rather than forced either way.
 */
const CASES = [
  // --- Clauses that reach outside this job -------------------------------
  {
    label: 'yes',
    category: 'outside_work',
    number: '6.1',
    text: '6.1 During the term of this Agreement the Employee shall not, without the prior written consent of the Company, engage in any other employment, consultancy, trade or business, whether or not for remuneration, and whether or not such activity competes with the business of the Company.',
  },
  {
    label: 'yes',
    category: 'ip_assignment',
    number: '9.2',
    text: '9.2 The Employee agrees that all Works conceived, created or developed by the Employee during the term of employment, whether or not during working hours, whether or not using the resources of the Company, and whether or not relating to the present business of the Company, shall be the sole and exclusive property of the Company.',
  },
  {
    label: 'yes',
    category: 'disclosure_duty',
    number: '7.1',
    text: '7.1 The Employee shall promptly disclose to the Company in writing any interest, direct or indirect, which conflicts or may conflict with the interests of the Company, including any shareholding, directorship, consultancy or family relationship bearing on the Company business.',
  },
  {
    label: 'yes',
    category: 'non_solicit',
    number: '11.1',
    text: '11.1 For a period of twelve (12) months after termination the Employee shall not solicit any client or customer of the Company with whom the Employee dealt in the twelve (12) months preceding termination, nor entice away any employee of the Company.',
  },
  {
    label: 'yes',
    category: 'confidentiality',
    number: '8.1',
    text: '8.1 The Employee shall not, during employment or at any time after its termination, disclose to any third party or use for their own benefit any confidential information of the Company, including source code, architecture, customer lists, pricing and roadmaps.',
  },
  {
    label: 'yes',
    category: 'non_compete',
    number: 'X.1',
    text: 'X.1 For a period of twelve (12) months following termination the Employee shall not, within the territory of India, establish, join or be engaged in any competing business or any similar business to that of the Company.',
  },

  // --- Clauses that cannot reach outside this job ------------------------
  {
    label: 'no',
    category: 'exclusivity',
    number: '4.1',
    text: '4.1 The Employee normal hours of work shall be forty-five (45) hours per week, Monday to Friday, and such additional hours as may reasonably be required for the proper discharge of their duties, for which no separate payment shall be made.',
  },
  {
    label: 'no',
    category: 'confidentiality',
    number: '3.2',
    text: '3.2 Remuneration is confidential to the Employee. The Employee shall not discuss the particulars of their compensation with other employees of the Company.',
  },
  {
    label: 'no',
    category: 'outside_work',
    number: '2.1',
    text: '2.1 The Employee shall be on probation for a period of six (6) months from the date of joining, which the Company may extend by a further three (3) months at its sole discretion.',
  },
  {
    label: 'no',
    category: 'outside_work',
    number: '14.1',
    text: '14.1 After confirmation, either party may terminate this Agreement by giving sixty (60) days written notice, or payment of basic salary in lieu thereof at the Company discretion.',
  },
  {
    label: 'no',
    category: 'ip_assignment',
    number: '13.1',
    text: '13.1 The Employee shall be entitled to eighteen (18) days of earned leave per calendar year, accruing monthly, of which no more than twelve (12) days may be carried forward. Leave records are the property of the Company.',
  },

  // --- Clauses that genuinely read both ways -----------------------------
  {
    label: 'unclear',
    category: 'exclusivity',
    number: '4.2',
    text: '4.2 The Employee shall devote the whole of their time, attention and skill during working hours to the business of the Company and shall use their best efforts to promote the interests of the Company.',
  },
  {
    label: 'unclear',
    category: 'disclosure_duty',
    number: '5.2',
    text: '5.2 The Employee shall at all times act in the best interests of the Company and shall not do anything which brings the Company into disrepute.',
  },
  {
    label: 'unclear',
    category: 'ip_assignment',
    number: '10.1',
    text: '10.1 Equipment, accounts, licences and credentials provided by the Company are for the business of the Company and shall not be used for any other purpose.',
  },
];

const h = await health();
if (!h.up) {
  console.log(`Model not running (${h.reason}). Start it with: ollama serve`);
  process.exit(2);
}

console.log(`\nModel: ${MODEL}   cases: ${CASES.length}\n`);

const rows = [];
let correct = 0;
let quoteOk = 0;
const started = Date.now();

for (const c of CASES) {
  const clause = { id: c.number, number: c.number, heading: '', text: c.text };
  let got = 'ERROR';
  let quote = '';
  try {
    const raw = await ask(buildPrompt({ clause, category: cat(c.category) }));
    got = ['yes', 'unclear', 'no'].includes(raw.governs_side_income) ? raw.governs_side_income : 'MALFORMED';
    quote = String(raw.quote || '');
  } catch (err) {
    got = `ERROR: ${err.message.slice(0, 40)}`;
  }
  const hit = got === c.label;
  const vq = verifyQuote(quote, c.text);
  if (hit) correct += 1;
  if (vq.ok) quoteOk += 1;
  rows.push({ clause: c.number, expected: c.label, got, quoteVerified: vq.ok, quoteReason: vq.ok ? '' : vq.reason });
  console.log(`  ${hit ? 'HIT ' : 'MISS'}  ${c.number.padEnd(5)} expected ${c.label.padEnd(7)} got ${String(got).padEnd(7)} quote ${vq.ok ? 'verified' : `REJECTED (${vq.reason})`}`);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);

// Where the mistakes cluster matters more than the headline number: calling a
// binding clause "no" is the failure that costs someone their job.
const confusion = {};
for (const r of rows) {
  const key = `${r.expected} -> ${r.got}`;
  confusion[key] = (confusion[key] || 0) + 1;
}

console.log(`\nClassification: ${correct}/${CASES.length} (${Math.round((correct / CASES.length) * 100)}%)`);
console.log(`Quotes verbatim: ${quoteOk}/${CASES.length} (${Math.round((quoteOk / CASES.length) * 100)}%)`);
console.log(`Time: ${secs}s total, ${(Number(secs) / CASES.length).toFixed(1)}s per clause\n`);
console.log('Confusion:');
for (const [k, v] of Object.entries(confusion).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v} x  ${k}`);
}

const dangerous = rows.filter((r) => r.expected === 'yes' && r.got === 'no').length;
console.log(`\nBinding clauses called harmless ("yes" -> "no"): ${dangerous}`);
console.log(JSON.stringify({ model: MODEL, correct, total: CASES.length, quoteOk, secs: Number(secs), confusion, dangerous }));
