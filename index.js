const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, Events, PermissionFlagsBits } = require('discord.js');

const STORAGE_PATH = path.join(__dirname, 'store.json');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf-8'));
  } catch {
    return { guilds: {}, broadcasts: {} };
  }
}

function saveStore(store) {
  fs.writeFileSync(STORAGE_PATH, JSON.stringify(store, null, 2));
}

function generateKey() {
  return crypto.randomBytes(24).toString('hex');
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

let store = loadStore();

app.get('/validate', (req, res) => {
  const key = req.header('x-api-key') || req.query.key;
  if (!key) return res.status(400).json({ error: 'Missing key' });

  const guildEntry = Object.values(store.guilds).find(g => g.apiKey === key);
  if (!guildEntry) return res.status(403).json({ error: 'Invalid API key' });
  return res.json({ valid: true });
});

app.post('/send', (req, res) => {
  const { type, title, message } = req.body;
  const key = req.header('x-api-key') || req.query.key;
  if (!key) return res.status(400).json({ error: 'Missing API key' });
  if (!type || !title || !message) return res.status(400).json({ error: 'Missing fields' });
  
  store = loadStore();
  const guildEntry = Object.values(store.guilds).find(g => g.apiKey === key);
  if (!guildEntry) return res.status(403).json({ error: 'Invalid API key' });

  const broadcast = {
    id: Date.now().toString(),
    type,
    title,
    message,
    timestamp: Date.now(),
  };

  store.broadcasts[key] = broadcast;
  saveStore(store);

  return res.json({ success: true });
});

app.get('/latest', (req, res) => {
  const key = req.header('x-api-key') || req.query.key;
  if (!key) return res.status(400).json({ error: 'Missing API key' });

  store = loadStore();
  if (!store.broadcasts[key]) return res.status(204).send();
  return res.json(store.broadcasts[key]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API server running on port ${PORT}`));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const syncCommand = new SlashCommandBuilder()
  .setName('sync')
  .setDescription('Generate or view this server’s API key for Roblox broadcasts')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

const broadcastCommand = new SlashCommandBuilder()
  .setName('broadcast')
  .setDescription('Send a message to all Roblox players for this guild')
  .addStringOption(option =>
    option.setName('type')
      .setDescription('Type of message')
      .setRequired(true)
      .addChoices(
        { name: 'Message', value: 'Message' },
        { name: 'Hint', value: 'Hint' }
      ))
  .addStringOption(option =>
    option.setName('title')
      .setDescription('Title')
      .setRequired(true))
  .addStringOption(option =>
    option.setName('message')
      .setDescription('Body')
      .setRequired(true));

const serversCommand = new SlashCommandBuilder()
  .setName('servers')
  .setDescription('Get number of active public servers for a Roblox place.')
  .addStringOption(option =>
    option.setName('placeid')
      .setDescription('Roblox place ID or universe ID')
      .setRequired(true));

async function registerCommandsForGuild(guildId) {
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
      { body: [syncCommand.toJSON(), broadcastCommand.toJSON(), serversCommand.toJSON()] }
    );
    console.log(`Registered commands for guild ${guildId}`);
  } catch (err) {
    console.error(`Failed to register commands for guild ${guildId}:`, err);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  for (const [guildId] of client.guilds.cache) {
    await registerCommandsForGuild(guildId);
  }
});

client.on(Events.GuildCreate, guild => {
  registerCommandsForGuild(guild.id);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  store = loadStore();

  const guildId = interaction.guildId;
  if (!guildId) return interaction.reply({ content: 'Must be used in a server.', ephemeral: true });

  if (interaction.commandName === 'sync') {
    let entry = store.guilds[guildId];
    if (!entry) {
      const newKey = generateKey();
      entry = { apiKey: newKey, createdAt: Date.now() };
      store.guilds[guildId] = entry;
      saveStore(store);
    }

    await interaction.reply({
      content: `API Key for this server: \`${entry.apiKey}\`\nYou must add the key to your Roblox game (use it as ?key=...).`,
      ephemeral: true
    });
    return;
  }

  if (interaction.commandName === 'broadcast') {
    const guildEntry = store.guilds[guildId];
    if (!guildEntry) {
      return interaction.reply({ content: 'This server is not synced. Run `/sync` first.', ephemeral: true });
    }

    const type = interaction.options.getString('type');
    const title = interaction.options.getString('title');
    const message = interaction.options.getString('message');

    try {
      const resp = await fetch(`${process.env.API_URL}/send?key=${encodeURIComponent(guildEntry.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, title, message })
      });

      if (!resp.ok) throw new Error('API error');

      await interaction.reply({ content: `Announcement sent for this server.\n**${type}**: ${title}`, ephemeral: true });
    } catch (err) {
      console.error('Failed announcement:', err);
      await interaction.reply({ content: 'Failed to send announcement.', ephemeral: true });
    }
    return;
  }

  if (interaction.commandName === 'servers') {
    const placeId = interaction.options.getString('placeid');

    try {
      let universeId = placeId;

      const placeInfoRes = await fetch(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${encodeURIComponent(placeId)}`);
      if (placeInfoRes.ok) {
        const placeInfo = await placeInfoRes.json();
        if (Array.isArray(placeInfo) && placeInfo[0] && placeInfo[0].universeId) {
          universeId = placeInfo[0].universeId;
        }
      }

      let total = 0;
      let cursor = nil
      do {
        const url = new URL(`https://games.roblox.com/v1/games/${encodeURIComponent(universeId)}/servers/Public`);
        url.searchParams.set('sortOrder', 'Asc');
        url.searchParams.set('limit', '100');
        if (cursor) url.searchParams.set('cursor', cursor);

        const pageRes = await fetch(url.toString());
        if (!pageRes.ok) break;
        const page = await pageRes.json();
        total += (page.data || []).length;
        cursor = page.nextPageCursor;
      } while (cursor);

      await interaction.reply({ content: `Total active public servers: ${total}` });
    } catch (err) {
      console.error('Error fetching servers:', err);
      await interaction.reply({ content: 'Failed to fetch server count.', ephemeral: true });
    }
    return;
  }
});

client.login(process.env.BOT_TOKEN);
