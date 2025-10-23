import { SlashCommandBuilder, ActionRowBuilder, TextInputBuilder, ModalBuilder, TextInputStyle, ComponentType } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Link this server with your API key and Place ID'),

  async execute(interaction, db, saveDB) {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply({
        content: 'You need administrator permissions to run setup.',
        flags: 64,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId('setupModal')
      .setTitle('Setup API Key and Place ID');

    const apiKeyInput = new TextInputBuilder()
      .setCustomId('apiKey')
      .setLabel('Enter your API key')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const placeIdInput = new TextInputBuilder()
      .setCustomId('placeId')
      .setLabel('Enter your Roblox Place ID')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(apiKeyInput),
      new ActionRowBuilder().addComponents(placeIdInput)
    );

    await interaction.showModal(modal);

    const submitted = await interaction.awaitModalSubmit({
      filter: i => i.customId === 'setupModal' && i.user.id === interaction.user.id,
      time: 60000,
      componentType: ComponentType.ModalSubmit,
    }).catch(() => null);

    if (!submitted) return;

    const apiKey = submitted.fields.getTextInputValue('apiKey');
    const placeId = submitted.fields.getTextInputValue('placeId');

    db[interaction.guild.id] = { apiKey, placeId };
    saveDB();

    await submitted.reply({
      content: 'Server linked successfully.',
      flags: 64,
    });
  },
};
