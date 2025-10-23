import { SlashCommandBuilder } from 'discord.js';
import fetch from 'node-fetch';
const API_URL = process.env.API_URL;

export default {
  data: new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Send an announcement through the linked API')
    .addStringOption(option =>
      option
        .setName('title')
        .setDescription('Announcement title')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('message')
        .setDescription('Announcement message')
        .setRequired(true)
    ),

  async execute(interaction, db) {
    const guildConfig = db[interaction.guild.id];
    if (!guildConfig || !guildConfig.apiKey || !guildConfig.placeId) {
      return interaction.reply({
        content: 'This server is not linked yet or missing a Place ID. Use /setup first.',
        ephemeral: true,
      });
    }

    const title = interaction.options.getString('title');
    const message = interaction.options.getString('message');

    try {
      const placeInfo = await fetch(`https://apis.roblox.com/universes/v1/places/${guildConfig.placeId}/universe`)
        .then(res => res.json());

      const universeId = placeInfo.universeId || null;
      if (!universeId) throw new Error('Failed to get Universe ID.');

      const res = await fetch(`${API_URL}/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guildId: interaction.guild.id,
          apiKey: guildConfig.apiKey,
          title,
          message,
          universeId,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'API error');

      await interaction.reply({
        content: `Announcement sent for Universe ${universeId}.\n${title}\n${message}`,
      });
    } catch (error) {
      console.error(error);
      await interaction.reply({
        content: 'Failed to send announcement.',
        ephemeral: true,
      });
    }
  },
};
