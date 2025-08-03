require('dotenv').config();

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

const store = loadStore();

app.get('/validate', (req, res) => {
  const key = req.header('x-api-key') || req.query.key;
  if (!key || !store.guilds) return res.status(400).json({ error: 'Missing key' });

  const guildEntry = Object.values(store.guilds).find(g => g.apiKey === key);
  if (!guildEntry) return res.status(403).json({ error: 'Invalid API key' });
  return res.json({ valid: true });
});

app.post('/send', (req, res) => {
  const { type, title, message } = req.body;
  const key = req.header('x-api-key') || req.query.key;
  if (!key) return res.status(400).json({ error: 'Missing API key' });
  if (!type || !title || !message) return res.status(400).json({ error: 'Missing fields' });

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

  console.log(`[API] Broadcast stored for key ${key}:`, broadcast);
  return res.json({ success: true });
});

app.get('/latest', (req, res) => {
  const key = req.header('x-api-key') || req.query.key;
  if (!key) return res.status(400).json({ error: 'Missing API key' });

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
        { name: 'Hint', value: 'Hint' },
      ))
  .addStringOption(option =>
    option.setName('title')
      .setDescription('Title')
      .setRequired(true))
  .addStringOption(option =>
    option.setName('message')
      .setDescription('Body')
      .setRequired(true));

client.once(Events.ClientReady, async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID),
      { body: [syncCommand.toJSON(), broadcastCommand.toJSON()] }
    );
    console.log('The commands are created.');
  } catch (err) {
    console.error('Failed to create the commands:', err);
  }

  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

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

    await interaction.reply({ content: `API Key for this server: \`${entry.apiKey}\`\nYou must configure your Roblox game to use /latest with this key.`, ephemeral: true });
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

      await interaction.reply({ content: `✅ Broadcast sent for this guild.\n**${type}**: ${title}`, ephemeral: false });
    } catch (err) {
      console.error('Failed broadcast:', err);
      await interaction.reply({ content: 'Failed to send broadcast.', ephemeral: true });
    }
    return;
  }
});

client.login(process.env.BOT_TOKEN);
