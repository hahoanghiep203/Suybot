import { config } from './config.js';

export const helpCommandName = '!help';

let cachedEntries = null;

export async function getCommandEntries() {
  if (cachedEntries) return cachedEntries;

  // Import dynamically at runtime to prevent top-level ES module circular dependencies
  const { features } = await import('./commands.js');
  const dynamicHelpEntries = features.map((feat) => feat.help).filter(Boolean);

  cachedEntries = [
    {
      name: '!help',
      aliases: ['/agent-help'],
      usage: '!help [search]',
      description: 'Show all commands, or search command names and usage.',
      examples: ['!help', '!help reset', '/agent-help query: workspace']
    },
    {
      name: config.discord.prefix,
      aliases: ['/agent', '@bot mention', 'DM'],
      usage: `${config.discord.prefix} <prompt>`,
      description: 'Ask the agent to answer, plan, search, or work with files in the agent workspace.',
      examples: [
        `${config.discord.prefix} summarize this channel goal`,
        `${config.discord.prefix} create a notes.md file for this project`,
        '/agent prompt: search today weather in Ho Chi Minh City'
      ]
    },
    {
      name: '/agent',
      aliases: [config.discord.prefix],
      usage: '/agent prompt:<prompt>',
      description: 'Slash command version of the agent prompt.',
      examples: ['/agent prompt: write a deployment checklist']
    },
    {
      name: '/dev-feature',
      aliases: ['developer tool', 'build feature'],
      usage: '/dev-feature prompt:<feature request>',
      description: 'Admin-only developer tool to build, test, and register new features for this bot.',
      examples: ['/dev-feature prompt: add a /ping command that replies pong']
    },
    ...dynamicHelpEntries
  ];

  return cachedEntries;
}

function matches(entry, query) {
  if (!query) return true;
  const haystack = [
    entry.name,
    entry.usage,
    entry.description,
    ...entry.aliases,
    ...entry.examples
  ].join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function formatEntry(entry) {
  const aliases = entry.aliases.length ? `\nAliases: ${entry.aliases.map((alias) => `\`${alias}\``).join(', ')}` : '';
  const examples = entry.examples.map((example) => `  ${example}`).join('\n');
  return `**${entry.name}**\nUsage: \`${entry.usage}\`${aliases}\n${entry.description}\nExamples:\n${examples}`;
}

export async function formatHelp(query = '') {
  const entries = await getCommandEntries();
  const normalizedQuery = query.trim();
  const matchesForQuery = entries.filter((entry) => matches(entry, normalizedQuery));

  if (!matchesForQuery.length) {
    return [
      `No commands found for \`${normalizedQuery}\`.`,
      `Use \`${helpCommandName}\` to list everything.`
    ].join('\n');
  }

  const title = normalizedQuery
    ? `Command help matching \`${normalizedQuery}\`:`
    : `Command help. Use \`${helpCommandName} <search>\` to filter.`;

  return [title, ...matchesForQuery.map(formatEntry)].join('\n\n');
}

export function isHelpMessage(content) {
  const trimmed = content.trim();
  return trimmed === helpCommandName || trimmed.startsWith(`${helpCommandName} `);
}

export function helpQueryFromMessage(content) {
  return content.trim().slice(helpCommandName.length).trim();
}
