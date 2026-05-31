import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

function fileFor(scopeId) {
  return path.join(config.paths.dataDir, 'conversations', `${scopeId}.json`);
}

export async function loadHistory(scopeId) {
  try {
    const raw = await fs.readFile(fileFor(scopeId), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function appendHistory(scopeId, entries) {
  const file = fileFor(scopeId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const current = await loadHistory(scopeId);
  const messages = [...current, ...entries].slice(-config.agent.maxHistoryMessages);
  await fs.writeFile(file, `${JSON.stringify({ messages }, null, 2)}\n`, 'utf8');
}

export async function clearHistory(scopeId) {
  try {
    await fs.rm(fileFor(scopeId), { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
