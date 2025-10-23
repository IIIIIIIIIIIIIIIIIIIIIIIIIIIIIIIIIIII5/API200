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
    )
    .addStringOption(option =>
      option
        .setName('universe')
        .setDescription('Select a universe to send the announcement to')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction, db) {
    const guildConfig = db[interaction.guild.id];
    if (!guildConfig || !guildConfig.apiKey || !guildConfig.placeId) {
      return interaction.respond([]);
    }

    try {
      const response = await fetch(`https://apis.roblox.com/universes/v1/places/${guildConfig.placeId}/universe`);
      const universeData = await response.json();
      const universeId = universeData.universeId;

      if (!universeId) return interaction.respond([]);

      const universeResponse = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
      const universeInfo = await universeResponse.json();

      if (!universeInfo.data || !universeInfo.data.length) return interaction.respond([]);

      const choices = universeInfo.data.map(u => ({
        name: u.name || `Universe ${u.id}`,
        value: `${u.id}`,
      }));

      await interaction.respond(choices.slice(0, 25));
    } catch (error) {
      console.error(error);
      await interaction.respond([]);
    }
  },

  async execute(interaction, db) {
    const guildConfig = db[interaction.guild.id];
    if (!guildConfig || !guildConfig.apiKey || !guildConfig.placeId) {
      return interaction.reply({
        content: 'This server is not linked yet or missing a Place ID. Use /setup first.',
        flags: 64,
      });
    }

    const title = interaction.options.getString('title');
    const message = interaction.options.getString('message');
    const universeId = interaction.options.getString('universe');

    try {
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
        flags: 64,
      });
    }
  },
};
