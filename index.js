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
    if (!fs.existsSync(STORAGE_PATH)) {
      const initial = { guilds: {}, broadcasts: {} };
      fs.writeFileSync(STORAGE_PATH, JSON.stringify(initial, null, 2), { mode: 0o600 });
      return initial;
    }
    const raw = fs.readFileSync(STORAGE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to load store.json, falling back to empty:', e);
    return { guilds: {}, broadcasts: {} };
  }
}

function saveStore(store) {
  try {
    const tempPath = STORAGE_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, STORAGE_PATH);
  } catch (e) {
    console.error('Atomic save failed, trying direct write:', e);
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
      .setDescription('Body')
      .setRequired(true));

const serversCommand = new SlashCommandBuilder()
  .setName('servers')
  .setDescription('Get the number of active public servers for a Roblox place.')
  .addStringOption(option =>
    option.setName('placeid')
      .setDescription('Roblox place ID or universe ID')
      .setRequired(true));

async function registerCommandsForGuild(guildId) {
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
      { body: [setupCommand.toJSON(), broadcastCommand.toJSON(), serversCommand.toJSON()] }
    );
    console.log(Created the commands for server ${guildId});
  } catch (err) {
    console.error(Failed to created commands for server ${guildId}:, err);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(Logged in as ${client.user.tag});
  for (const [guildId] of client.guilds.cache) {
    await registerCommandsForGuild(guildId);
  }
});

client.on(Events.GuildCreate, guild => {
  registerCommandsForGuild(guild.id);
});

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'setup') {
      const focused = interaction.options.getFocused();
      const suggestions = VALID_PERMS
        .filter(p => p.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25)
        .map(p => ({ name: p, value: p }));
      await interaction.respond(suggestions);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  store = loadStore();
  const guildId = interaction.guildId;
  if (!guildId) return interaction.reply({ content: 'Must be used in a server.', ephemeral: true });

  if (interaction.commandName === 'setup') {
    const chosen = interaction.options.getString('permission');

   if (!VALID_PERMS.includes(chosen)) {
    const sample = ['ManageGuild', 'ManageMessages', 'KickMembers', 'BanMembers', 'Administrator'];
    return interaction.reply({
      content: `Invalid permission ${chosen}. Examples: ${sample.join(', ')}.`,
      ephemeral: true
    });
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

    await interaction.reply({ content: `API Key: ${entry.apiKey}\nRequired permission to use announce/servers: ${entry.requiredPermission}.`, ephemeral: true });
    return;
  }

  const guildEntry = store.guilds[guildId];
  if (!guildEntry && (interaction.commandName === 'announce' || interaction.commandName === 'servers')) {
    return interaction.reply({ content: 'This server is not set up. Run /setup first.', ephemeral: true });
  }

  const requiredPerm = guildEntry?.requiredPermission || 'ManageGuild';
  const hasPermission = interaction.member.permissions
    ? interaction.member.permissions.has(PermissionFlagsBits[requiredPerm])
    : false;

  if ((interaction.commandName === 'announce' || interaction.commandName === 'servers') && !hasPermission) {
    return interaction.reply({ content: You do not have the required permission (\${requiredPerm}\) to use this command., ephemeral: true });
  }

  if (interaction.commandName === 'announce') {
    const type = interaction.options.getString('type');
    const title = interaction.options.getString('title');
    const message = interaction.options.getString('message');

    try {
      const resp = await fetch(${process.env.API_URL}/send?key=${encodeURIComponent(guildEntry.apiKey)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, title, message })
      });

      if (!resp.ok) throw new Error('API error');
      await interaction.reply({ content: Announcement sent.\n**${type}**: ${title}, ephemeral: true });
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
      let cursor = null;
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

      await interaction.reply({ content: Total active servers: ${total} });
    } catch (err) {
      console.error('Error fetching servers:', err);
      await interaction.reply({ content: 'Failed to fetch server count.', ephemeral: true });
    }
    return;
  }
});

client.login(process.env.BOT_TOKEN);
