import { SlashCommandBuilder } from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execAsync = promisify(exec);

export const feature = {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Admin-only: Delete a dynamically developed feature and its unit tests.')
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('The exact file basename of the feature to delete (excluding .js extension, e.g. whatIsTheAnswer).')
        .setRequired(true)
    ),

  async execute(interaction) {
    // 1. Check permissions
    if (!config.discord.adminUserIds.has(interaction.user.id)) {
      await interaction.reply({ content: '❌ Unauthorized: Only administrators can run this command.', ephemeral: true });
      return;
    }

    const featureName = interaction.options.getString('name', true).trim();
    const cleanName = featureName.endsWith('.js') ? featureName.slice(0, -3) : featureName;

    // Core protection list - cannot delete core commands
    const coreFeatures = ['agentHelp', 'reset', 'remove'];
    if (coreFeatures.includes(cleanName)) {
      await interaction.reply({ content: `❌ Error: Cannot delete core bot command: \`${cleanName}\`.`, ephemeral: true });
      return;
    }

    const projectRoot = process.cwd();
    const featurePath = path.resolve(projectRoot, `src/features/${cleanName}.js`);
    const testPath = path.resolve(projectRoot, `test/${cleanName}.test.js`);

    let deletedFeature = false;
    let deletedTest = false;

    // Try to delete the feature file
    try {
      await fs.access(featurePath);
      await fs.unlink(featurePath);
      deletedFeature = true;
    } catch {
      // Feature file not found
    }

    // Try to delete the test file
    try {
      await fs.access(testPath);
      await fs.unlink(testPath);
      deletedTest = true;
    } catch {
      // Test file not found
    }

    if (!deletedFeature && !deletedTest) {
      await interaction.reply({
        content: `❌ Error: No custom feature or test files found for name \`${cleanName}\`.`,
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    // Sync changes with Discord API
    let regOutput = '';
    try {
      const { stdout } = await execAsync('npm run register', { cwd: projectRoot });
      regOutput = stdout.trim();
    } catch (regErr) {
      regOutput = `Command registration error: ${regErr.message}`;
    }

    await interaction.editReply({
      content: `✅ **Feature "${cleanName}" Removed Successfully!**\n\n**Deleted Files:**\n${deletedFeature ? `- src/features/${cleanName}.js\n` : ''}${deletedTest ? `- test/${cleanName}.test.js\n` : ''}\n**Discord Sync:**\n\`${regOutput}\`\n\n🔄 **Bot is restarting now to apply changes...**`
    });

    // Trigger Command Process restart by exiting
    setTimeout(() => {
      process.exit(0);
    }, 1500);
  },

  help: {
    name: '/remove',
    aliases: [],
    usage: '/remove name:<feature_name>',
    description: 'Admin-only: Deletes a dynamically generated custom feature module and its matching test file, updating Discord command sync.',
    examples: ['/remove name: whatIsTheAnswer']
  }
};
