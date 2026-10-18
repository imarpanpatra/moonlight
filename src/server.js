import express from 'express';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { health, IS_LOCAL, MODEL, OLLAMA } from './gemma.js';
import { review } from './review.js';

/** Contracts are long. This is generous, and the front end is told when it is exceeded. */
const MAX_BODY = '4mb';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const app = express();
// A contract is a big paste. Nothing here is uploaded anywhere, so the only
// limit that matters is not running the laptop out of memory.
app.use(express.json({ limit: MAX_BODY }));

// Body-parser failures arrive here. Without this, an oversized paste got
// express's default HTML error page, the front end ran res.json() on it, and
// the user was shown "Unexpected token '<'" instead of being told the contract
// was too large. Every path out of this server returns JSON.
app.use((err, _req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `That contract is larger than ${MAX_BODY}. Try the relevant sections.` });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request body was not valid JSON.' });
  }
  return res.status(500).json({ error: err.message });
});

app.use(express.static(join(root, 'public')));

app.get('/api/health', async (_req, res) => {
  res.json({ ...(await health()), host: OLLAMA, model: MODEL, local: IS_LOCAL });
});

app.get('/api/sample', async (_req, res) => {
  try {
    const text = await readFile(join(root, 'data', 'sample-contract.txt'), 'utf8');
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/review', async (req, res) => {
  const text = String(req.body?.text || '');
  if (text.trim().length < 200) {
    return res.status(400).json({ error: 'That is too short to be a contract. Paste the whole thing.' });
  }

  const state = await health();
  if (!state.up) {
    return res.status(503).json({
      error: `The local model is not running. Start it with: ollama serve  (looking at ${OLLAMA})`,
    });
  }
  if (!state.installed) {
    return res.status(503).json({ error: `Model ${MODEL} is not installed. Run: ollama pull ${MODEL}` });
  }

  try {
    // review() clamps this; passing it through raw is what let a negative
    // limit silently drop candidates off the end of the list.
    const result = await review(text, { limit: req.body?.limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = Number(process.env.PORT) || 4455;
app.listen(port, '127.0.0.1', () => {
  console.log(`Moonlight on http://127.0.0.1:${port}`);
  console.log(
    IS_LOCAL
      ? `Model ${MODEL} via ${OLLAMA}. Nothing leaves this machine.`
      : `Model ${MODEL} via ${OLLAMA}. WARNING: that is not this machine.`,
  );
});
