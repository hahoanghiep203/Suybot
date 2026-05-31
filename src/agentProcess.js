import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials
} from 'discord.js';
import fs from 'node:fs/promises';
import { config } from './config.js';
import { respond } from './agent.js';
import { ensureWorkspace } from './tools.js';
import { formatHelp, helpQueryFromMessage, isHelpMessage } from './help.js';
import {
  clearSession,
  getChangedFiles,
  getVerificationResults,
  isRestartRequired,
  executeDevTool
} from './devTools.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

function splitDiscordMessage(text) {
  const chunks = [];
  for (let index = 0; index < text.length; index += 1900) {
    chunks.push(text.slice(index, index + 1900));
  }
  return chunks.length ? chunks : ['Done.'];
}

function scopeFor(message) {
  const guild = message.guildId || 'dm';
  const channel = message.channelId;
  return `${guild}-${channel}`;
}

function stripTrigger(message) {
  const content = message.content.trim();
  const mention = `<@${client.user.id}>`;
  const nicknameMention = `<@!${client.user.id}>`;

  if (content.startsWith(config.discord.prefix)) {
    return content.slice(config.discord.prefix.length).trim();
  }
  if (content.startsWith(mention)) {
    return content.slice(mention.length).trim();
  }
  if (content.startsWith(nicknameMention)) {
    return content.slice(nicknameMention.length).trim();
  }
  return content;
}

function shouldReply(message) {
  if (message.author.id === client.user.id) return false;
  if (message.author.bot && !config.discord.allowBotMessages) return false;
  if (message.channel.type === ChannelType.DM) return true;
  if (isHelpMessage(message.content)) return true;
  if (message.content.startsWith(config.discord.prefix)) return true;
  if (message.mentions.users.has(client.user.id)) return true;
  return config.discord.allowedChannelIds.has(message.channelId);
}

async function replyLong(target, text) {
  for (const chunk of splitDiscordMessage(text)) {
    await target.reply(chunk);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  await ensureWorkspace();
  console.log(`Agent Process logged in as ${readyClient.user.tag}`);
});

// Handle conversational prompts
client.on(Events.MessageCreate, async (message) => {
  if (!shouldReply(message)) return;

  if (isHelpMessage(message.content)) {
    await replyLong(message, await formatHelp(helpQueryFromMessage(message.content)));
    return;
  }

  const prompt = stripTrigger(message);
  if (!prompt) return;

  // Let Command Process deal with direct command prefixes that aren't for the agent
  if (message.content.startsWith(config.discord.prefix)) {
    const contentWithoutPrefix = message.content.slice(config.discord.prefix.length).trim();
    const cmd = contentWithoutPrefix.split(/\s+/)[0]?.toLowerCase();
    // Allow !agent but ignore prefix commands like !ping, !reset, !download-images, etc.
    const commandList = ['ping', 'reset', 'help', 'agent-help', 'download-images'];
    if (commandList.includes(cmd)) {
      return;
    }
  }

  try {
    await message.channel.sendTyping();
    const answer = await respond(scopeFor(message), message.author.username, prompt);
    await replyLong(message, answer);
  } catch (error) {
    console.error(error);
    await message.reply(`Agent error: ${error.message}`);
  }
});

// Handle IPC messages from Coordinator
process.on('message', async (ipcMessage) => {
  console.log('Agent Process received IPC message:', ipcMessage.type);
  
  if (ipcMessage.type === 'DELEGATE_TO_AGENT') {
    const { channelId, messageId, authorName, prompt, reason } = ipcMessage;
    
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) return;
      
      await channel.sendTyping();
      
      const explanationPrompt = `The user ${authorName} tried to run a prefix command that was invalid or unrecognized: "${prompt}".
Reason/Error: ${reason}
Please explain what was wrong with the syntax or command, guide them on what commands are available, and help them out nicely.`;
      
      const answer = await respond(`${channel.guildId || 'dm'}-${channelId}`, authorName, explanationPrompt);
      
      try {
        const message = await channel.messages.fetch(messageId);
        await replyLong(message, answer);
      } catch {
        await channel.send(`${authorName}, ${answer}`);
      }
    } catch (error) {
      console.error('Error handling delegated command in Agent Process:', error);
    }
    return;
  }
  
  if (ipcMessage.type === 'COGNITIVE_PROMPT') {
    const { interactionId, commandName, prompt, channelId, userName, scopeId, isAdmin } = ipcMessage;
    
    if (commandName === 'agent') {
      try {
        const answer = await respond(scopeId, userName, prompt);
        process.send({
          type: 'INTERACTION_UPDATE',
          interactionId,
          text: answer,
          status: 'complete'
        });
      } catch (error) {
        console.error(error);
        process.send({
          type: 'INTERACTION_UPDATE',
          interactionId,
          text: `Agent error: ${error.message}`,
          status: 'error'
        });
      }
      return;
    }
    
    if (commandName === 'dev-feature') {
      if (!isAdmin) {
        process.send({
          type: 'INTERACTION_UPDATE',
          interactionId,
          text: 'Unauthorized: Only administrators can run this command.',
          status: 'error'
        });
        return;
      }
      
      try {
        clearSession();
        
        process.send({
          type: 'INTERACTION_UPDATE',
          interactionId,
          text: '⚙️ Development agent is planning and building the feature...',
          status: 'progress'
        });
        
        let answer = await respond(scopeId, userName, prompt, { isDev: true });
        
        const checkCommands = ['npm run check', 'npm test', 'npm run register'];
        const runAutoVerifications = async () => {
          const verification = getVerificationResults();
          for (const cmd of checkCommands) {
            if (verification.get(cmd) !== 'passed') {
              console.log(`Auto-verifying in Agent child: ${cmd}`);
              try {
                await executeDevTool('run_command', { command: cmd });
              } catch (err) {
                console.error(`Auto-verification failed for ${cmd}:`, err.message);
              }
            }
          }
        };

        await runAutoVerifications();
        
        let verification = getVerificationResults();
        let allPassed = checkCommands.every((cmd) => verification.get(cmd) === 'passed');
        
        // SELF-HEALING LOOP: If any check failed, automatically trigger a repair cycle!
        let healingAttempts = 0;
        const maxHealingAttempts = 2;
        
        while (!allPassed && healingAttempts < maxHealingAttempts) {
          healingAttempts++;
          console.log(`[Self-Healing] Checks failed. Attempt ${healingAttempts}/${maxHealingAttempts} to repair...`);
          
          process.send({
            type: 'INTERACTION_UPDATE',
            interactionId,
            text: `⚙️ Tests or syntax checks failed. Development agent is attempting to auto-repair the codebase (Attempt ${healingAttempts}/${maxHealingAttempts})...`,
            status: 'progress'
          });
          
          const failedCommandsSummary = checkCommands
            .filter((cmd) => verification.get(cmd) !== 'passed')
            .map((cmd) => `- \`${cmd}\` is failing.`)
            .join('\n');
            
          const repairPrompt = `The dynamic automated checks failed with the following status:
${failedCommandsSummary}

Please:
1. Read the failing test files, feature files, or shell console outputs to diagnose the problem.
2. Edit the code and test files under src/features/ and test/ to resolve all syntax errors, assertion failures, or runtime exceptions.
3. Run 'npm run check', 'npm test', and 'npm run register' inside your tools to verify everything is passing.
Do not finish your answer until ALL verification checks have successfully passed!`;

          answer = await respond(scopeId, userName, repairPrompt, { isDev: true });
          
          await runAutoVerifications();
          verification = getVerificationResults();
          allPassed = checkCommands.every((cmd) => verification.get(cmd) === 'passed');
        }
        
        const changed = getChangedFiles();
        const restart = isRestartRequired();
        const restartChannelAllowed =
          config.discord.devAutoRestartChannelIds.size === 0 ||
          config.discord.devAutoRestartChannelIds.has(channelId);
        const shouldAutoRestart =
          config.discord.devAutoRestart &&
          allPassed &&
          restart &&
          restartChannelAllowed;
        
        let responseContent = '';
        if (changed.length > 0) {
          responseContent += '**Changed:**\n' + changed.map((f) => `- ${f}`).join('\n') + '\n\n';
        } else {
          responseContent += '**Changed:**\n- No files were changed.\n\n';
        }
        
        responseContent += '**Verification:**\n';
        for (const cmd of checkCommands) {
          const status = verification.get(cmd) ?? 'not run';
          responseContent += `- ${cmd}: ${status}\n`;
        }
        
        for (const [cmd, status] of verification.entries()) {
          if (!checkCommands.includes(cmd)) {
            responseContent += `- ${cmd}: ${status}\n`;
          }
        }
        responseContent += '\n';
        
        responseContent += '**Restart required:**\n';
        if (restart) {
          const fsExists = async (p) => {
            try {
              await fs.access(p);
              return true;
            } catch {
              return false;
            }
          };
          const isDocker = await fsExists('/.dockerenv');
          if (isDocker) {
            responseContent += '```bash\ndocker compose up -d --build\n```';
          } else {
            responseContent += '```bash\nnpm start\n```';
          }
        } else {
          responseContent += 'No restart required.';
        }
        
        if (shouldAutoRestart) {
          responseContent += '\n\n🔄 **Auto-restart triggered:** All verifications passed in an approved dev channel. Coordinator is reloading the command process now...';
        }
        
        if (answer && answer.trim() !== 'Done.') {
          responseContent += `\n\n**Agent Summary:**\n${answer}`;
        }
        
        process.send({
          type: 'INTERACTION_UPDATE',
          interactionId,
          text: responseContent,
          status: 'complete'
        });
        
        if (shouldAutoRestart) {
          try {
            const testChannel = await client.channels.fetch(channelId);
            if (testChannel) {
              await testChannel.send(`🧪 **[Live Testing Channel Verification]** Running smoke test suite...
✅ **Syntax Verification**: Checked all modified files.
✅ **Unit Tests**: Passed all modular test suites.
✅ **Discord Sync**: Successfully registered new commands.
🔄 **Action**: All verifications passed in this channel. Coordinator is restarting the Command Process now...`);
            }
          } catch (discordErr) {
            console.error('Error posting test channel notice:', discordErr.message);
          }

          console.log('Requesting Coordinator to restart Command Process...');
          process.send({ type: 'RESTART_COMMANDS' });
        }
      } catch (error) {
        console.error(error);
        process.send({
          type: 'INTERACTION_UPDATE',
          interactionId,
          text: `Agent error during dev-feature execution: ${error.message}`,
          status: 'error'
        });
      }
    }
  }
});

client.login(config.discord.token).catch((error) => {
  console.error('Agent Process failed to login:', error);
  process.exit(1);
});
