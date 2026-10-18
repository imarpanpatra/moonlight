const $ = (id) => document.getElementById(id);

const contract = $('contract');
const goBtn = $('go');
const sampleBtn = $('sample');
const statusEl = $('status');
const results = $('results');
const findingsEl = $('findings');
const statline = $('statline');
const absentEl = $('absent');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Read a response as JSON, or explain it.
 *
 * Not every reply is JSON: a payload that exceeds the body limit, or a proxy in
 * the way, returns HTML, and calling res.json() on it threw "Unexpected token
 * '<'" at the user. They pasted a contract and were shown a parser error.
 */
async function readJson(res) {
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch {
    if (res.status === 413) return { error: 'That contract is too large to send in one go.' };
    return { error: `The server replied with ${res.status} and something that was not JSON.` };
  }
}

async function checkHealth() {
  const badge = $('offline');
  const text = $('offline-text');
  try {
    const h = await readJson(await fetch('/api/health'));
    if (h.local === false) {
      // The promise on the rest of this page is not true in this configuration.
      badge.className = 'offline down';
      text.textContent = `OLLAMA_HOST points at ${h.host}, which is not this machine. Your contract would be sent there.`;
    } else if (h.up && h.installed) {
      badge.className = 'offline up';
      text.textContent = `${h.model}, running on this machine. Nothing is uploaded.`;
    } else if (h.up) {
      badge.className = 'offline down';
      text.textContent = `${h.model} is not installed. Run: ollama pull ${h.model}`;
    } else {
      badge.className = 'offline down';
      text.textContent = 'The local model is not running. Start it with: ollama serve';
    }
  } catch {
    badge.className = 'offline down';
    text.textContent = 'Cannot reach the local server.';
  }
}

sampleBtn.addEventListener('click', async () => {
  sampleBtn.disabled = true;
  try {
    const data = await readJson(await fetch('/api/sample'));
    if (data.text) contract.value = data.text;
    else statusEl.textContent = data.error || 'Could not load the sample contract.';
  } catch (err) {
    statusEl.textContent = err.message;
  } finally {
    sampleBtn.disabled = false;
  }
});

goBtn.addEventListener('click', async () => {
  const text = contract.value;
  if (text.trim().length < 200) {
    statusEl.textContent = 'That is too short to be a contract.';
    return;
  }

  goBtn.disabled = true;
  statusEl.textContent = 'Reading, locally. A 4B model takes a few seconds per clause…';
  findingsEl.innerHTML = '';
  absentEl.innerHTML = '';
  results.hidden = true;

  try {
    const res = await fetch('/api/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await readJson(res);
    if (!res.ok) {
      results.hidden = false;
      statline.textContent = '';
      findingsEl.innerHTML = `<div class="error">${esc(data.error)}</div>`;
      return;
    }
    render(data);
  } catch (err) {
    results.hidden = false;
    findingsEl.innerHTML = `<div class="error">${esc(err.message)}</div>`;
  } finally {
    goBtn.disabled = false;
    statusEl.textContent = '';
  }
});

function render(data) {
  const { stats, findings, absent } = data;

  // Already ordered by the server, by what each clause does. Not re-sorted
  // here, and in particular not sorted by anything the model decided.
  statline.textContent =
    `${stats.clauses} clauses in document · ${stats.candidates} matched on keywords · ` +
    `${stats.read} quotes verified · ${stats.unverified + stats.unread} readings discarded · ` +
    (stats.skipped ? `${stats.skipped} further matches not read · ` : '') +
    `0 verdicts given · ${(stats.ms / 1000).toFixed(1)}s · nothing left this laptop`;

  findingsEl.innerHTML = findings
    .map((f) => (f.state === 'read' ? card(f) : rejectedCard(f)))
    .join('');

  // Left empty when there is nothing to say, because the styled border-top
  // would otherwise draw a divider under an empty box.
  absentEl.innerHTML = '';
  if (absent.length) {
    absentEl.innerHTML =
      '<strong>Not found anywhere in this document:</strong><ul>' +
      absent.map((a) => `<li>${esc(a.categoryLabel)}</li>`).join('') +
      '</ul><p>Absence here means no clause matched the retrieval keywords. ' +
      'It is a statement about this document, not a guarantee about your position.</p>';
  }

  results.hidden = false;
}

/** Flags come from the clause text, so each one shows the words that triggered it. */
function flagList(f) {
  if (!f.flags.length) return '';
  return `<ul class="flags">${f.flags
    .map(
      (fl) => `<li>
        <strong>${esc(fl.label)}</strong> ${esc(fl.note)}
        <span class="ev">${esc(fl.evidence)}</span>
      </li>`,
    )
    .join('')}</ul>`;
}

function card(f) {
  const severity = f.flags.length === 0 ? 'no' : f.flags.length >= 3 ? 'yes' : 'unclear';

  return `
    <article class="finding ${severity}">
      <div class="fhead">
        <span class="cat">${esc(f.categoryLabel)}</span>
        <span class="num">clause ${esc(f.number)}${f.heading ? ` · ${esc(f.heading)}` : ''}</span>
        ${f.duration ? `<span class="tag">${esc(f.duration)}</span>` : ''}
      </div>
      <blockquote>${esc(f.quote)}</blockquote>
      ${flagList(f)}
      ${f.effect ? `<p class="effect">${esc(f.effect)}</p>` : ''}
      ${f.question ? `<p class="q">${esc(f.question)}</p>` : ''}
      <details>
        <summary>The clause in full, and how it was found</summary>
        <pre>${esc(f.text)}</pre>
        <pre>matched on: ${esc(f.matchedOn.join(', '))}</pre>
      </details>
    </article>`;
}

/** A clause we found but will not characterise, and why. */
function rejectedCard(f) {
  const why = {
    'not-in-document': 'the model quoted a sentence that is not in your contract',
    'too-short': 'the quote was too short to be evidence of anything',
    elided: 'the quote was abbreviated instead of copied',
    empty: 'the model quoted nothing',
  }[f.reason] || esc(f.reason);

  return `
    <article class="finding unverified">
      <div class="fhead">
        <span class="cat">${esc(f.categoryLabel)}</span>
        <span class="num">clause ${esc(f.number)}${f.heading ? ` · ${esc(f.heading)}` : ''}</span>
        <span class="tag">located, not read</span>
      </div>
      <p class="effect">
        This clause matched on <em>${esc(f.matchedOn.join(', '))}</em>, so it is
        probably relevant. The reading was discarded because ${why}. Read it yourself.
      </p>
      ${flagList(f)}
      <details open>
        <summary>The clause in full</summary>
        <pre>${esc(f.text)}</pre>
        ${f.discarded ? `<pre>discarded reading: ${esc(f.discarded)}</pre>` : ''}
      </details>
    </article>`;
}

checkHealth();
