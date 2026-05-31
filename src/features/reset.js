import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execAsync = promisify(exec);

export const feature = {
  data: new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Admin-only: Reset all custom features and restore the bot to a clean state.'),

  async execute(interaction) {
    // 1. Check permissions
    if (!config.discord.adminUserIds.has(interaction.user.id)) {
      await interaction.reply({ content: '❌ Unauthorized: Only administrators can run this command.', flags: MessageFlags.Ephemeral });
      return;
    }

    // 2. Ask for confirmation using Buttons
    const confirmButton = new ButtonBuilder()
      .setCustomId('confirm_reset')
      .setLabel('Confirm Reset')
      .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
      .setCustomId('cancel_reset')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

    const response = await interaction.reply({
      content: '⚠️ **WARNING**: This action will permanently delete all dynamically developed features and their corresponding test files, restoring the bot to its clean state.\nAre you absolutely sure you want to proceed?',
      components: [row],
      flags: MessageFlags.Ephemeral
    });

    // 3. Collect the response
    const collectorFilter = (i) => i.user.id === interaction.user.id;

    try {
      const confirmation = await response.awaitMessageComponent({
        filter: collectorFilter,
        componentType: ComponentType.Button,
        time: 20000 // 20 seconds timeout
      });

      if (confirmation.customId === 'confirm_reset') {
        await confirmation.update({ content: '⚙️ Resetting codebase to clean state... Please wait.', components: [] });

        const projectRoot = process.cwd();
        const featuresDir = path.resolve(projectRoot, 'src/features');
        const testDir = path.resolve(projectRoot, 'test');

        const coreFeatures = new Set(['agentHelp.js', 'reset.js', 'remove.js', 'ytPlay.js']);
        const coreTests = new Set(['bot.test.js']);

        // Remove non-core features
        const featureFiles = await fs.readdir(featuresDir);
        const deletedFeatures = [];
        for (const file of featureFiles) {
          if (file.endsWith('.js') && !coreFeatures.has(file)) {
            await fs.unlink(path.join(featuresDir, file));
            deletedFeatures.push(file);
          }
        }

        // Remove non-core tests
        const testFiles = await fs.readdir(testDir);
        const deletedTests = [];
        for (const file of testFiles) {
          if (file.endsWith('.js') && !coreTests.has(file)) {
            await fs.unlink(path.join(testDir, file));
            deletedTests.push(file);
          }
        }

        // Re-register commands with Discord
        let regOutput = '';
        try {
          const { stdout } = await execAsync('npm run register', { cwd: projectRoot });
          regOutput = stdout.trim();
        } catch (regErr) {
          regOutput = `Command registration error: ${regErr.message}`;
        }

        await interaction.followUp({
          content: `✅ **Codebase Reset Completed Successfully!**\n\n**Deleted Features:**\n${deletedFeatures.map(f => `- src/features/${f}`).join('\n') || '- None'}\n\n**Deleted Tests:**\n${deletedTests.map(t => `- test/${t}`).join('\n') || '- None'}\n\n**Discord Sync:**\n\`${regOutput}\`\n\n🔄 **Bot is restarting now...**`,
          flags: MessageFlags.Ephemeral
        });

        // Trigger Command Process restart by exiting
        setTimeout(() => {
          process.exit(0);
        }, 1500);

      } else if (confirmation.customId === 'cancel_reset') {
        await confirmation.update({ content: '❌ Reset action cancelled.', components: [] });
      }
    } catch (e) {
      await interaction.editReply({ content: '⏱️ Reset confirmation timed out. Action aborted.', components: [] });
    }
  },

  help: {
    name: '/reset',
    aliases: [],
    usage: '/reset',
    description: 'Admin-only: Reset and delete all dynamic custom feature modules and tests, bringing the bot back to a clean state with two-step confirmation.',
    examples: ['/reset']
  }
};
