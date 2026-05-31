import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function list(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const root = process.cwd();

export const config = {
  discord: {
    token: required('DISCORD_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
    guildId: process.env.DISCORD_GUILD_ID || null,
    prefix: process.env.BOT_PREFIX || '!agent',
    allowedChannelIds: new Set(list('ALLOWED_CHANNEL_IDS')),
    allowBotMessages: bool('DISCORD_ALLOW_BOT_MESSAGES', false),
    adminUserIds: new Set(list('ADMIN_USER_IDS')),
    devAutoRestart: bool('DEV_AUTO_RESTART', false),
    devAutoRestartChannelIds: new Set(list('DEV_AUTO_RESTART_CHANNEL_IDS'))
  },
  ai: {
    apiKey: required('AI_API_KEY'),
    model: process.env.AI_MODEL || 'gemma-4-31b-it',
    temperature: Number.parseFloat(process.env.AI_TEMPERATURE || '0.2'),
    thinkingLevel: process.env.GOOGLE_THINKING_LEVEL || 'high',
    enableSearch: bool('GOOGLE_ENABLE_SEARCH', true),
    enableUrlContext: bool('GOOGLE_ENABLE_URL_CONTEXT', true),
    includeSources: bool('GOOGLE_INCLUDE_SOURCES', true)
  },
  paths: {
    workspace: path.resolve(root, process.env.AGENT_WORKSPACE || 'agent_workspace'),
    dataDir: path.resolve(root, process.env.DATA_DIR || 'data')
  },
  agent: {
    maxHistoryMessages: int('MAX_HISTORY_MESSAGES', 24),
    maxToolRounds: int('MAX_TOOL_ROUNDS', 5)
  },
  tools: {
    allowShell: bool('ALLOW_SHELL_TOOLS', false),
    allowedCommands: new Set(list('ALLOWED_COMMANDS').length ? list('ALLOWED_COMMANDS') : ['node', 'npm', 'git']),
    commandTimeoutMs: int('COMMAND_TIMEOUT_MS', 15000)
  }
};
