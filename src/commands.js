import { SlashCommandBuilder } from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const featuresDir = path.resolve(projectRoot, 'src/features');

// Define core commands that require process-level routing (delegation)
const coreBuilders = [
  new SlashCommandBuilder()
    .setName('agent')
    .setDescription('Ask the AI agent to do something.')
    .addStringOption((option) =>
      option
        .setName('prompt')
        .setDescription('What you want the agent to do.')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('dev-feature')
    .setDescription('Develop and verify a new feature for this Discord bot.')
    .addStringOption((option) =>
      option
        .setName('prompt')
        .setDescription('Description of the feature to develop.')
        .setRequired(true)
    )
];

const coreCommands = coreBuilders.map((cmd) => cmd.toJSON());

// Load dynamic feature modules
const files = await fs.readdir(featuresDir);
const loadedFeatures = [];

for (const file of files) {
  if (file.endsWith('.js')) {
    const modulePath = `./features/${file}`;
    const mod = await import(modulePath);
    const feat = mod.feature || mod.default;
    if (feat) {
      loadedFeatures.push(feat);
    }
  }
}

export const features = loadedFeatures;

// Combine core commands and dynamic features for API registration
export const commands = [
  ...coreCommands,
  ...loadedFeatures.map((feat) => feat.data.toJSON ? feat.data.toJSON() : feat.data)
];
