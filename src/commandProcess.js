import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials
} from 'discord.js';
import { config } from './config.js';
import { features } from './commands.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

// Stored active interactions to update them with progress from the Agent Process
const activeInteractions = new Map();

function splitDiscordMessage(text) {
  const chunks = [];
  for (let index = 0; index < text.length; index += 1900) {
    chunks.push(text.slice(index, index + 1900));
  }
  return chunks.length ? chunks : ['Done.'];
}

function scopeFor(interactionOrMessage) {
  const guild = interactionOrMessage.guildId || 'dm';
  const channel = interactionOrMessage.channelId;
  return `${guild}-${channel}`;
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Command Process logged in as ${readyClient.user.tag}`);
});

// Listen to message prefix commands
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  
  const content = message.content.trim();
  const prefix = config.discord.prefix;
  
  let contentWithoutPrefix = null;
  let directPrefixCommand = null;

  if (content.startsWith(prefix)) {
    contentWithoutPrefix = content.slice(prefix.length).trim();
  } else if (content.startsWith('!')) {
    const directParts = content.slice(1).trim().split(/\s+/);
    directPrefixCommand = directParts[0]?.toLowerCase();
    const directFeature = features.find((feature) => {
      const directCommands = new Set([
        ...(feature.prefixCommands ?? []),
        ...(feature.help?.aliases ?? [])
          .filter((alias) => alias.startsWith('!'))
          .map((alias) => alias.slice(1))
      ].map((command) => command.toLowerCase()));

      return directCommands.has(directPrefixCommand);
    });

    if (!directFeature || typeof directFeature.executePrefix !== 'function') return;

    try {
      await directFeature.executePrefix(message, directParts.slice(1), directPrefixCommand);
    } catch (error) {
      console.error(`Command Process error executing direct prefix command ${directPrefixCommand}:`, error.message);
      delegateToAgent(message, `Command syntax/runtime error in ${directPrefixCommand}: ${error.message}`);
    }
    return;
  } else {
    return;
  }

  const parts = contentWithoutPrefix.split(/\s+/);
  const commandName = parts[0]?.toLowerCase();
  
  if (!commandName) {
    delegateToAgent(message, 'No command specified.');
    return;
  }
  
  const feature = features.find((f) => {
    if (f.data.name.toLowerCase() === commandName) return true;
    return (f.prefixCommands ?? []).map((command) => command.toLowerCase()).includes(commandName);
  });
  
  try {
    if (feature && typeof feature.executePrefix === 'function') {
      await feature.executePrefix(message, parts.slice(1), commandName);
      return;
    }
    
    // Unrecognized prefix command - delegate to Agent
    delegateToAgent(message, `Unrecognized prefix command: ${commandName}`);
  } catch (error) {
    console.error(`Command Process error executing prefix command ${commandName}:`, error.message);
    // Syntax or execution error - delegate back to Agent to explain/fix
    delegateToAgent(message, `Command syntax/runtime error in ${commandName}: ${error.message}`);
  }
});

function delegateToAgent(message, reason) {
  if (process.send) {
    process.send({
      type: 'DELEGATE_TO_AGENT',
      channelId: message.channelId,
      messageId: message.id,
      authorName: message.author.username,
      prompt: message.content,
      reason
    });
  } else {
    message.reply(`Command syntax or unrecognized command. (Coordinator not active, cannot ask Agent). Details: ${reason}`);
  }
}

// Handle Slash Commands
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    const feature = features.find((f) => typeof f.handleButton === 'function' && f.handlesButton?.(interaction.customId));
    if (!feature) return;

    try {
      await feature.handleButton(interaction);
    } catch (error) {
      console.error(`Error executing button ${interaction.customId}:`, error.message);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `Button failed: ${error.message}`, flags: MessageFlags.Ephemeral });
      }
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  
  const { commandName } = interaction;
  
  // Find feature dynamically in registry
  const feature = features.find((f) => f.data.name === commandName);
  
  if (feature) {
    try {
      await feature.execute(interaction);
    } catch (error) {
      console.error(`Error executing slash command ${commandName}:`, error.message);
      const replyContent = `Execution failed: ${error.message}`;
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: replyContent, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.editReply(replyContent);
      }
    }
    return;
  }
  
  // Cognitive commands: /agent and /dev-feature (handled as core delegations)
  if (commandName === 'agent' || commandName === 'dev-feature') {
    await interaction.deferReply();
    
    // Store active interaction
    activeInteractions.set(interaction.id, interaction);
    
    if (process.send) {
      process.send({
        type: 'COGNITIVE_PROMPT',
        interactionId: interaction.id,
        commandName,
        prompt: interaction.options.getString('prompt', true),
        channelId: interaction.channelId,
        userName: interaction.user.username,
        scopeId: scopeFor(interaction),
        isAdmin: config.discord.adminUserIds.has(interaction.user.id)
      });
    } else {
      await interaction.editReply('Error: Parent coordinator is offline. Prompt cannot be sent to Agent.');
    }
  }
});

// Listen to IPC messages from the Coordinator
process.on('message', async (message) => {
  if (message.type === 'INTERACTION_UPDATE') {
    const { interactionId, text, status } = message;
    const interaction = activeInteractions.get(interactionId);
    
    if (!interaction) {
      console.warn(`Received INTERACTION_UPDATE for unrecognized interaction ID: ${interactionId}`);
      return;
    }
    
    try {
      const chunks = splitDiscordMessage(text);
      await interaction.editReply(chunks.shift());
      for (const chunk of chunks) {
        await interaction.followUp(chunk);
      }
    } catch (error) {
      console.error(`Error updating interaction ${interactionId}:`, error.message);
    } finally {
      if (status === 'complete' || status === 'error') {
        activeInteractions.delete(interactionId);
      }
    }
  }
});

client.login(config.discord.token).catch((error) => {
  console.error('Command Process failed to login:', error);
  process.exit(1);
});
