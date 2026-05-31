import { SlashCommandBuilder } from 'discord.js';
import { formatHelp } from '../help.js';

export const feature = {
  data: new SlashCommandBuilder()
    .setName('agent-help')
    .setDescription('Show how to use the agent bot.')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('Optional command search text.')
        .setRequired(false)
    ),

  async execute(interaction) {
    const query = interaction.options.getString('query') ?? '';
    await interaction.reply(await formatHelp(query));
  },

  async executePrefix(message, args) {
    const query = args.join(' ');
    const splitDiscordMessage = (text) => {
      const chunks = [];
      for (let index = 0; index < text.length; index += 1900) {
        chunks.push(text.slice(index, index + 1900));
      }
      return chunks.length ? chunks : ['Done.'];
    };
    for (const chunk of splitDiscordMessage(await formatHelp(query))) {
      await message.reply(chunk);
    }
  },

  help: {
    name: '/agent-help',
    aliases: ['!help'],
    usage: '/agent-help [query:<search>]',
    description: 'Show help from a slash command, optionally filtered by search text.',
    examples: ['/agent-help', '/agent-help query: reset']
  }
};
