import { SlashCommandBuilder } from 'discord.js';

export const feature = {
    data: new SlashCommandBuilder()
        .setName('ask')
        .setDescription('Ask a question')
        .addStringOption(option => 
            option.setName('question')
                .setDescription('The question to ask')
                .setRequired(true)),
    async execute(interaction) {
        const question = interaction.options.getString('question').toLowerCase();
        
        if (question === 'who is epstin') {
            await interaction.reply('duy anh');
        } else {
            await interaction.reply('ur mom');
        }
    },
    help: {
        name: '/ask',
        aliases: [],
        usage: '/ask <question>',
        description: 'Ask a question and get a funny answer',
        examples: ['/ask who is epstin', '/ask what is the meaning of life']
    }
};
