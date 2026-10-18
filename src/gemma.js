// The only thing in this project that talks to a model, and the only thing
// that opens a socket. The socket goes to 127.0.0.1.

/**
 * Ollama's own documented format for this variable is "host:port", with no
 * scheme — `OLLAMA_HOST=127.0.0.1:11434`. Passing that straight to fetch()
 * throws "Failed to parse URL", which surfaced in the interface as "the local
 * model is not running, start it with ollama serve": wrong, and it sends you
 * off to debug a server that is already running. So the scheme is added if the
 * variable does not carry one.
 */
function resolveHost(raw) {
  const value = String(raw || '').trim();
  if (!value) return 'http://127.0.0.1:11434';
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  return withScheme.replace(/\/+$/, '');
}

export const OLLAMA = resolveHost(process.env.OLLAMA_HOST);
export const MODEL = process.env.MOONLIGHT_MODEL || 'gemma3:4b';

/**
 * This project's whole claim is that the contract does not leave the machine,
 * and OLLAMA_HOST is the one setting that could break it. Pointing it at a
 * remote Ollama would quietly ship every clause off this laptop, so say so
 * loudly rather than let the interface keep promising otherwise.
 */
export const IS_LOCAL = (() => {
  try {
    const { hostname } = new URL(OLLAMA);
    return /^(127\.\d+\.\d+\.\d+|::1|\[::1\]|localhost)$/i.test(hostname);
  } catch {
    return false;
  }
})();

if (!IS_LOCAL) {
  console.warn(
    `WARNING: OLLAMA_HOST points at ${OLLAMA}, which is not this machine.\n` +
    'Contract text will be sent there. Unset OLLAMA_HOST to keep it local.',
  );
}

/**
 * Ask the local model one question and get JSON back.
 *
 * temperature 0 and a fixed seed, because the same clause should produce the
 * same reading twice. This is a document people will act on.
 */
export async function ask(prompt, { timeoutMs = 90_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0, seed: 7, num_predict: 400 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    const body = await res.json();
    return parseJson(body.response);
  } finally {
    clearTimeout(timer);
  }
}

/** Ollama's json format is reliable but not guaranteed. Fail loudly, never guess. */
function parseJson(raw) {
  const text = String(raw || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new Error(`model did not return JSON: ${text.slice(0, 200)}`);
  }
}

/** Is the local model up? Used to fail with a useful message instead of a stack trace. */
export async function health() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { up: false, reason: `ollama ${res.status}` };
    const { models = [] } = await res.json();
    const names = models.map((m) => m.name);
    return {
      up: true,
      model: MODEL,
      installed: names.includes(MODEL),
      available: names,
    };
  } catch (err) {
    return { up: false, reason: err.message };
  }
}

/**
 * The prompt. Note what it does not ask for.
 *
 * It never asks "is this allowed", "can they do this", or "what should the
 * employee do". A 4B model asked a legal question will answer it, confidently,
 * and be wrong in a way that costs someone their job. So the question put to
 * the model is a reading-comprehension question: which sentence here is the
 * operative one, and what does it place on the employee.
 */
export function buildPrompt({ clause, category }) {
  return `You are reading one clause of an employment contract. You are not giving legal advice. Never state whether something is allowed, legal, enforceable or advisable.

The clause may be about: ${category.label}.

CLAUSE ${clause.number}${clause.heading ? ` (${clause.heading})` : ''}:
"""
${clause.text}
"""

Answer with JSON only, with exactly these five keys.

"governs_side_income" — decide from the words of the clause:
  "yes"     the clause can reach activity or creations OUTSIDE this job. Signs: it restricts other employment, consultancy, trade or business; it claims ownership of things created outside working hours or unrelated to the employer's business; it requires disclosure of outside interests; it binds the employee after termination.
  "no"      the clause can only ever concern conduct inside this job, and nothing in it reaches outside activity. Signs: it is limited to working hours, or to company equipment, or it is about pay, leave, notice or probation.
  "unclear" ONLY when the clause's own wording genuinely supports both readings.
  Do not answer "unclear" because you feel uncertain, or because the clause does not use the words "side business". Decide from the text. Most clauses are "yes" or "no".

"quote" — the single most operative sentence or phrase from the clause, copied WORD FOR WORD from the text above. Copy the characters exactly as they appear. Never paraphrase, never correct grammar, never abbreviate with "...". If nothing in the clause is operative, use "".

"effect" — one sentence under 25 words saying what the clause places on the employee. Describe only; do not advise and do not evaluate.

"requires_consent" — true only if the clause requires permission, approval, notification or disclosure before or during outside work.

"question" — one question under 20 words for the employee to put to their employer or a lawyer. It must be specific to THIS clause and name the exact words in it that create the doubt. Do not ask a generic question.

Examples of the shape wanted (for other contracts, not this one):
{"governs_side_income":"yes","quote":"shall not, without the prior written consent of the Company, undertake any other paid work","effect":"The employee needs written permission before taking on any other paid work.","requires_consent":true,"question":"Who grants consent under this clause, and how long do they have to answer?"}
{"governs_side_income":"no","quote":"shall be entitled to twenty-one days of paid leave per calendar year","effect":"The clause sets the employee's annual paid leave.","requires_consent":false,"question":"Does unused leave carry into the next year?"}

JSON only. No prose around it.`;
}
