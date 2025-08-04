const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, Events, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

const STORAGE_PATH = path.join(__dirname, 'store.json');

function loadStore() {
  try {
    if (!fs.existsSync(STORAGE_PATH)) {
      const initial = { guilds: {}, broadcasts: {}, kicks: {} };
      fs.writeFileSync(STORAGE_PATH, JSON.stringify(initial, null, 2), { mode: 0o600 });
      return initial;
    }
    const raw = fs.readFileSync(STORAGE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.kicks) parsed.kicks = {};
    if (!parsed.broadcasts) parsed.broadcasts = {};
    if (!parsed.guilds) parsed.guilds = {};
    return parsed;
  } catch (e) {
    console.error('Failed to load store.json, falling back to empty:', e);
    return { guilds: {}, broadcasts: {}, kicks: {} };
  }
}

function saveStore(store) {
  try {
    const tempPath = STORAGE_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, STORAGE_PATH);
  } catch (e) {
    console.error('Save failed, trying direct write:', e);
    try {
      fs.writeFileSync(STORAGE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
    } catch (inner) {
      console.error('Direct write also failed:', inner);
    }
  }
}

function generateKey() {
  return crypto.randomBytes(24).toString('hex');
}

function extractKey(req) {
  return req.header('x-api-key') || req.query.key;
}

function formatReadable(ts) {
  if (!ts) return null;
  const d = new Date(Number(ts));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const sec = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`;
}

function requireBasicAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="keys"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  const b64 = auth.slice('Basic '.length);
  let decoded;
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf-8');
  } catch {
    return res.status(400).json({ error: 'Bad auth header' });
  }
  const [user, pass] = decoded.split(':');
  if (
    user === process.env.KEYS_USER &&
    pass === process.env.KEYS_PASS
  ) {
    return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="keys"');
  return res.status(403).json({ error: 'Forbidden' });
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

let store = loadStore();

app.get('/keys', requireBasicAuth, (req, res) => {
  store = loadStore();
  const output = {};

  for (const [guildId, entry] of Object.entries(store.guilds)) {
    output[guildId] = {
      apiKey: entry.apiKey,
      requiredPermission: entry.requiredPermission,
      createdAt: entry.createdAt,
      createdAtReadable: entry.createdAt ? formatReadable(entry.createdAt) : null
    };
  }

  res.json(output);
});

app.get('/validate', (req, res) => {
  const key = extractKey(req);
  if (!key) return res.status(400).json({ error: 'Missing key' });

  store = loadStore();
  const guildEntry = Object.values(store.guilds).find(g => g.apiKey === key);
  if (!guildEntry) return res.status(403).json({ error: 'Invalid API key' });
  return res.json({ valid: true, requiredPermission: guildEntry.requiredPermission || 'ManageGuild' });
});

app.post('/kick', async (req, res) => {
  const { targetUsername, reason } = req.body;
  const key = extractKey(req);
  if (!key) return res.status(400).json({ error: 'Missing API key' });
  if (!targetUsername) return res.status(400).json({ error: 'Missing targetUsername' });

  store = loadStore();
  const guildEntry = Object.values(store.guilds).find(g => g.apiKey === key);
  if (!guildEntry) return res.status(403).json({ error: 'Invalid API key' });

  let targetUserId;
  try {
    const resp = await fetch(`https://api.roblox.com/users/get-by-username?username=${encodeURIComponent(targetUsername)}`);
    const data = await resp.json();
    if (!data || !data.Id) {
      return res.status(404).json({ error: 'Roblox username not found' });
    }
    targetUserId = data.Id;
  } catch (e) {
    return res.status(500).json({ error: 'Failed to resolve Roblox username' });
  }

  const kickPayload = {
    id: Date.now().toString(),
    targetUserId: String(targetUserId),
    reason: reason || 'No reason provided',
    timestamp: Date.now(),
  };

  store.kicks[key] = kickPayload;
  saveStore(store);

  return res.json({ success: true });
});

app.post('/send', (req, res) => {
  const { type, title, message } = req.body;
  const key = extractKey(req);
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
  const key = extractKey(req);
  if (!key) return res.status(400).json({ error: 'Missing API key' });

  store = loadStore();
  if (!store.broadcasts[key]) return res.status(204).send();
  return res.json(store.broadcasts[key]);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API server running on port ${PORT}`));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const VALID_PERMS = Object.keys(PermissionFlagsBits);

const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Generate/view this server’s API key and choose required permission for broadcasts')
  .addStringOption(option =>
    option
      .setName('permission')
      .setDescription('Discord permission required to use /announce and /servers')
      .setRequired(true)
      .setAutocomplete(true)
  );

const broadcastCommand = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Send a message to all players in game')
  .addStringOption(option =>
    option
      .setName('type')
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
      .setDescription('Message')
      .setRequired(true));

const serversCommand = new SlashCommandBuilder()
  .setName('servers')
  .setDescription('Get the number of active servers for a game.')
  .addStringOption(option =>
    option.setName('placeid')
      .setDescription('Roblox place ID')
      .setRequired(true));

const kickCommand = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kick a Roblox player from the game')
  .addStringOption(option =>
    option
      .setName('username')
      .setDescription('Username to kick')
      .setRequired(true))
  .addStringOption(option =>
    option
      .setName('reason')
      .setDescription('Reason for kick'));

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: [setupCommand.toJSON(), broadcastCommand.toJSON(), serversCommand.toJSON(), kickCommand.toJSON()] }
    );
    console.log('Slash commands registered.');
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
})();

client.once(Events.ClientReady, () => {
  console.log('Discord client ready!');
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;

  if (interaction.commandName === 'setup') {
    const chosen = interaction.options.getString('permission');

    if (!VALID_PERMS.includes(chosen)) {
      const sample = ['ManageGuild', 'ManageMessages', 'KickMembers', 'BanMembers', 'Administrator'];
      return interaction.reply({ content: `Invalid permission ${chosen}. Examples: ${sample.join(', ')}.`, ephemeral: true });
    }

    store = loadStore();
    let entry = store.guilds[guildId];
    if (!entry) {
      const newKey = generateKey();
      entry = {
        apiKey: newKey,
        createdAt: Date.now(),
        requiredPermission: chosen
      };
    } else {
      entry.requiredPermission = chosen;
    }
    store.guilds[guildId] = entry;
    saveStore(store);

    const embed = new EmbedBuilder()
      .setTitle('Setup Complete')
      .setColor(0x00FF00)
      .addFields(
        { name: 'API Key', value: `\`${entry.apiKey}\``, inline: false },
        { name: 'Required Permission', value: `\`${entry.requiredPermission}\``, inline: true },
        { name: 'Created At', value: `<t:${Math.floor(entry.createdAt / 1000)}:F>`, inline: true }
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (interaction.commandName === 'announce') {
    const type = interaction.options.getString('type');
    const title = interaction.options.getString('title');
    const message = interaction.options.getString('message');

    store = loadStore();
    const entry = store.guilds[guildId];
    if (!entry) {
      return interaction.reply({ content: 'This server has not been setup yet. Use /setup first.', ephemeral: true });
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits[entry.requiredPermission])) {
      return interaction.reply({ content: `You need the permission ${entry.requiredPermission} to send announcements.`, ephemeral: true });
    }

    store.broadcasts[entry.apiKey] = {
      id: Date.now().toString(),
      type,
      title,
      message,
      timestamp: Date.now()
    };
    saveStore(store);

    await interaction.reply({ content: 'Announcement sent.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'servers') {
    const placeId = interaction.options.getString('placeid');

    try {
      const resp = await fetch(`https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100`);
      const data = await resp.json();
      if (!data || !data.data) {
        return interaction.reply({ content: 'Failed to get servers data.', ephemeral: true });
      }

      const count = data.data.length;
      await interaction.reply({ content: `There are currently ${count} public servers for place ID ${placeId}.`, ephemeral: true });
    } catch (e) {
      await interaction.reply({ content: 'Error fetching servers.', ephemeral: true });
    }
    return;
  }

  if (interaction.commandName === 'kick') {
    const username = interaction.options.getString('username');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    store = loadStore();
    const entry = store.guilds[guildId];
    if (!entry) {
      return interaction.reply({ content: 'This server has not been setup yet. Use /setup first.', ephemeral: true });
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits[entry.requiredPermission])) {
      return interaction.reply({ content: `You need the permission ${entry.requiredPermission} to kick players.`, ephemeral: true });
    }

    let userId;
    try {
      const resp = await fetch(`https://api.roblox.com/users/get-by-username?username=${encodeURIComponent(username)}`);
      const data = await resp.json();
      if (!data || !data.Id) {
        return interaction.reply({ content: `Roblox user ${username} not found.`, ephemeral: true });
      }
      userId = data.Id;
    } catch {
      return interaction.reply({ content: 'Failed to look up Roblox user.', ephemeral: true });
    }

    const kickPayload = {
      id: Date.now().toString(),
      targetUserId: String(userId),
      reason,
      timestamp: Date.now(),
    };

    store.kicks[entry.apiKey] = kickPayload;
    saveStore(store);

    await interaction.reply({ content: `Kick request sent for user ${username}.`, ephemeral: true });
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
