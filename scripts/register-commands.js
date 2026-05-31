import { REST, Routes } from 'discord.js';
import { config } from '../src/config.js';
import { commands } from '../src/commands.js';

const rest = new REST({ version: '10' }).setToken(config.discord.token);

try {
  const application = await rest.get('/oauth2/applications/@me');
  if (application.id !== config.discord.clientId) {
    throw new Error(
      `DISCORD_CLIENT_ID is ${config.discord.clientId}, but this token belongs to application ${application.id} (${application.name}).`
    );
  }
} catch (error) {
  if (error.status || error.code) {
    throw error;
  }
  console.error(error.message);
  process.exit(1);
}

if (config.discord.guildId) {
  await rest.put(
    Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
    { body: commands }
  );
  console.log(`Registered ${commands.length} guild commands.`);
} else {
  await rest.put(
    Routes.applicationCommands(config.discord.clientId),
    { body: commands }
  );
  console.log(`Registered ${commands.length} global commands.`);
}
