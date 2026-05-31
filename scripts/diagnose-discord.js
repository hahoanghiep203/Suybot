import { REST, Routes } from 'discord.js';
import { config } from '../src/config.js';

const rest = new REST({ version: '10' }).setToken(config.discord.token);
const application = await rest.get('/oauth2/applications/@me');
const guilds = await rest.get(Routes.userGuilds());
const globalCommands = await rest.get(Routes.applicationCommands(application.id));

const result = {
  application: {
    id: application.id,
    name: application.name,
    configuredClientId: config.discord.clientId,
    clientIdMatchesToken: application.id === config.discord.clientId
  },
  inviteUrl: `https://discord.com/oauth2/authorize?client_id=${application.id}&scope=bot%20applications.commands&permissions=2147485696`,
  guilds: guilds.map((guild) => ({
    id: guild.id,
    name: guild.name,
    selectedForGuildCommands: config.discord.guildIds.includes(guild.id)
  })),
  globalCommands: globalCommands.map((command) => ({
    name: command.name,
    options: command.options?.map((option) => option.name) ?? []
  })),
  guildCommands: {}
};

for (const guild of guilds) {
  const commands = await rest.get(Routes.applicationGuildCommands(application.id, guild.id));
  result.guildCommands[guild.id] = commands.map((command) => ({
    name: command.name,
    options: command.options?.map((option) => option.name) ?? []
  }));
}

console.log(JSON.stringify(result, null, 2));
