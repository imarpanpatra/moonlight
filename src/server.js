import express from 'express';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { health, MODEL, OLLAMA } from './gemma.js';
import { review } from './review.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const app = express();
// A contract is a big paste. Nothing here is uploaded anywhere, so the only
// limit that matters is not running the laptop out of memory.
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(root, 'public')));

app.get('/api/health', async (_req, res) => {
  res.json({ ...(await health()), host: OLLAMA, model: MODEL });
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
    const result = await review(text, { limit: Number(req.body?.limit) || 12 });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = Number(process.env.PORT) || 4455;
app.listen(port, '127.0.0.1', () => {
  console.log(`Moonlight on http://127.0.0.1:${port}`);
  console.log(`Model ${MODEL} via ${OLLAMA}. Nothing leaves this machine.`);
});
