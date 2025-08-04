const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, Events, PermissionFlagsBits } = require('discord.js');
const sqlite3 = require('sqlite3');

const DB_PATH = path.join(__dirname, 'store.sqlite');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error("SQLite open error:", err);
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS guilds (
      guildId TEXT PRIMARY KEY,
      apiKey TEXT UNIQUE,
      requiredPermission TEXT,
      createdAt INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS broadcasts (
      apiKey TEXT PRIMARY KEY,
      id TEXT,
      type TEXT,
      title TEXT,
      message TEXT,
      timestamp INTEGER
    )
  `);
});

function generateKey() {
  return crypto.randomBytes(24).toString('hex');
}

function extractKey(req) {
  return req.header('x-api-key') || req.query.key;
}

function getGuildByApiKey(apiKey) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM guilds WHERE apiKey = ?`, [apiKey], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function getGuildEntry(guildId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM guilds WHERE guildId = ?`, [guildId], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function upsertGuild(guildId, apiKey, requiredPermission) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO guilds(guildId, apiKey, requiredPermission, createdAt)
      VALUES(?,?,?,?)
      ON CONFLICT(guildId) DO UPDATE SET requiredPermission=excluded.requiredPermission
    `,
      [guildId, apiKey, requiredPermission, Date.now()],
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function setBroadcast(apiKey, broadcast) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO broadcasts(apiKey,id,type,title,message,timestamp)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(apiKey) DO UPDATE SET
        id=excluded.id,
        type=excluded.type,
        title=excluded.title,
        message=excluded.message,
        timestamp=excluded.timestamp
    `,
      [apiKey, broadcast.id, broadcast.type, broadcast.title, broadcast.message, broadcast.timestamp],
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function getBroadcast(apiKey) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM broadcasts WHERE apiKey = ?`, [apiKey], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
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
  if (user === process.env.KEYS_USER && pass === process.env.KEYS_PASS) {
    return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="keys"');
  return res.status(403).json({ error: 'Forbidden' });
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.get('/keys', requireBasicAuth, async (req, res) => {
  db.all(`SELECT * FROM guilds`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    const out = {};
    for (const entry of rows) {
      out[entry.guildId] = {
        apiKey: entry.apiKey,
        requiredPermission: entry.requiredPermission,
        createdAt: entry.createdAt,
        createdAtReadable: formatReadable(entry.createdAt),
      };
    }
    res.json(out);
  });
});

app.get('/validate', async (req, res) => {
  const key = extractKey(req);
  if (!key) return res.status(400).json({ error: 'Missing key' });
  try {
    const guildEntry = await getGuildByApiKey(key);
    if (!guildEntry) return res.status(403).json({ error: 'Invalid API key' });
    return res.json({ valid: true, requiredPermission: guildEntry.requiredPermission || 'ManageGuild' });
  } catch (e) {
    return res.status(500).json({ error: 'Internal' });
  }
});

app.post('/send', async (req, res) => {
  const { type, title, message } = req.body;
  const key = extractKey(req);
  if (!key) return res.status(400).json({ error: 'Missing API key' });
  if (!type || !title || !message) return res.status(400).json({ error: 'Missing fields' });
  try {
    const guildEntry = await getGuildByApiKey(key);
    if (!guildEntry) return res.status(403).json({ error: 'Invalid API key' });
    const broadcast = {
      id: Date.now().toString(),
      type,
      title,
      message,
      timestamp: Date.now(),
    };
    await setBroadcast(key, broadcast);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: 'Internal' });
  }
});

app.get('/latest', async (req, res) => {
  const key = extractKey(req);
  if (!key) return res.status(400).json({ error: 'Missing API key' });
  try {
    const broadcast = await getBroadcast(key);
    if (!broadcast) return res.status(204).send();
    return res.json(broadcast);
  } catch (e) {
    return res.status(500).json({ error: 'Internal' });
  }
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
    console.log(`Created the commands for server ${guildId}`);
  } catch (err) {
    console.error(`Failed to created commands for server ${guildId}:`, err);
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

  const guildId = interaction.guildId;
  if (!guildId) return interaction.reply({ content: 'Must be used in a server.', ephemeral: true });

  if (interaction.commandName === 'setup') {
    const chosen = interaction.options.getString('permission');
    if (!VALID_PERMS.includes(chosen)) {
      const sample = ['ManageGuild', 'ManageMessages', 'KickMembers', 'BanMembers', 'Administrator'];
      return interaction.reply({
        content: `Invalid permission \`${chosen}\`. Examples: ${sample.map(p => `\`${p}\``).join(', ')}.`,
        ephemeral: true
      });
    }

    try {
      const existing = await getGuildEntry(guildId);
      let apiKey;
      if (!existing) {
        apiKey = generateKey();
      } else {
        apiKey = existing.apiKey;
      }
      await upsertGuild(guildId, apiKey, chosen);
      const updated = await getGuildEntry(guildId);
      await interaction.reply({ content: `API Key: \`${updated.apiKey}\`\nRequired permission to use announce/servers: \`${updated.requiredPermission}\`.`, ephemeral: true });
    } catch (err) {
      console.error("Setup error:", err);
      await interaction.reply({ content: 'Failed to setup.', ephemeral: true });
    }
    return;
  }

  if (interaction.commandName === 'announce' || interaction.commandName === 'servers') {
    let guildEntry;
    try {
      guildEntry = await getGuildEntry(guildId);
    } catch (e) {
      console.error("Fetch guild entry error:", e);
    }

    if (!guildEntry) {
      return interaction.reply({ content: 'This server is not set up. Run `/setup` first.', ephemeral: true });
    }

    const requiredPerm = guildEntry.requiredPermission || 'ManageGuild';
    const hasPermission = interaction.member.permissions
      ? interaction.member.permissions.has(PermissionFlagsBits[requiredPerm])
      : false;

    if (!hasPermission) {
      return interaction.reply({ content: `You do not have the required permission (\`${requiredPerm}\`) to use this command.`, ephemeral: true });
    }

    if (interaction.commandName === 'announce') {
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
        await interaction.reply({ content: `Announcement sent.\n**${type}**: ${title}`, ephemeral: true });
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

        await interaction.reply({ content: `Total active servers: ${total}` });
      } catch (err) {
        console.error('Error fetching servers:', err);
        await interaction.reply({ content: 'Failed to fetch server count.', ephemeral: true });
      }
      return;
    }
  }
});

client.login(process.env.BOT_TOKEN);
