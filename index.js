const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, Events, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const admin = require('firebase-admin');

const privateKey = process.env.PRIVATEKEY.replace(/\\n/g, '\n');

const serviceAccount = {
  project_id: process.env.PROJECTID,
  client_email: process.env.CLIENTEMAIL,
  private_key: privateKey,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const token = process.env.BOT_TOKEN;
console.log("Token is:", token ? "set" : "NOT set");

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

async function loadStore() {
  const doc = await db.collection('store').doc('data').get();
  if (!doc.exists) {
    return { guilds: {}, broadcasts: {}, kicks: {} };
  }
  return doc.data();
}

async function saveStore(store) {
  await db.collection('store').doc('data').set(store);
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

app.get('/keys', requireBasicAuth, asyncHandler(async (req, res) => {
  const store = await loadStore();
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
}));

app.get('/kick/latest', asyncHandler(async (req, res) => {
  const key = extractKey(req);
  if (!key) return res.status(400).json({ error: 'Missing API key' });

  const store = await loadStore();
  const payload = store.kicks[key];
  if (!payload) return res.status(204).send();

  delete store.kicks[key];
  await saveStore(store);

  return res.json(payload);
}));

app.get('/validate', asyncHandler(async (req, res) => {
  const key = extractKey(req);
  if (!key) return res.status(400).json({ error: 'Missing key' });

  const store = await loadStore();
  const guildEntry = Object.values(store.guilds).find(g => g.apiKey === key);
  if (!guildEntry) return res.status(403).json({ error: 'Invalid API key' });
  return res.json({ valid: true, requiredPermission: guildEntry.requiredPermission || 'ManageGuild' });
}));

app.post('/kick', asyncHandler(async (req, res) => {
  const { targetUsername, reason } = req.body;
  const key = extractKey(req);
  if (!key) return res.status(400).json({ error: 'Missing API key' });
  if (!targetUsername) return res.status(400).json({ error: 'Missing targetUsername' });

  const store = await loadStore();
  const guildEntry = Object.values(store.guilds).find(g => g.apiKey === key);
  if (!guildEntry) return res.status(403).json({ error: 'Invalid API key' });

  let targetUserId;
  try {
    const resp = await fetch('://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usernames: [targetUsername],
        excludeBannedUsers: false
      })
    });
    if (!resp.ok) {
      return res.status(500).json({ error: 'Roblox API failure' });
    }
    const data = await resp.json();
    if (
      !data ||
      !Array.isArray(data.data) ||
      data.data.length === 0 ||
      typeof data.data[0].id !== 'number'
    ) {
      return res.status(404).json({ error: 'Roblox username not found' });
    }
    targetUserId = data.data[0].id;
  } catch (e) {
    console.error('Username lookup error:', e);
    return res.status(500).json({ error: 'Failed to find Roblox username' });
  }

  const kickPayload = {
    id: Date.now().toString(),
    targetUserId: String(targetUserId),
    reason: reason || 'No reason provided',
    timestamp: Date.now(),
  };

  store.kicks[key] = kickPayload;
  await saveStore(store);

  return res.json({ success: true });
}));

app.post('/send', asyncHandler(async (req, res) => {
  const { type, title, message } = req.body;
  const key = extractKey(req);
  if (!key) return res.status(400).json({ error: 'Missing API key' });
  if (!type || !title || !message) return res.status(400).json({ error: 'Missing fields' });

  const store = await loadStore();
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
  await saveStore(store);

  return res.json({ success: true });
}));

app.get('/latest', asyncHandler(async (req, res) => {
  const key = extractKey(req);
  if (!key) return res.status(400).json({ error: 'Missing API key' });

  const store = await loadStore();
  if (!store.broadcasts[key]) return res.status(204).send();
  return res.json(store.broadcasts[key]);
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API server running on port ${PORT}`));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const VALID_PERMS = Object.keys(PermissionFlagsBits);

const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Generate/view this server’s API key and choose the required permission for commands')
  .addStringOption(option =>
    option
      .setName('permission')
      .setDescription('Discord permission required to use commands')
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
        { name: 'hint', value: 'hint' },
        { name: 'message', value: 'message' }
      )
  )
  .addStringOption(option =>
    option
      .setName('title')
      .setDescription('Message title')
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName('message')
      .setDescription('Message body')
      .setRequired(true)
  );

const kickCommand = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Queue a Roblox user to be kicked in-game')
  .addStringOption(option =>
    option
      .setName('username')
      .setDescription('Roblox username to kick')
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName('reason')
      .setDescription('Reason for kick')
      .setRequired(false)
  );

(async () => {
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: [setupCommand.toJSON(), broadcastCommand.toJSON()] }
    );
    console.log('Commands created.');
  } catch (error) {
    console.error(error);
  }
})();

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'setup') {
    const requestedPerm = interaction.options.getString('permission');
    if (!VALID_PERMS.includes(requestedPerm)) {
      await interaction.reply({ content: `Invalid permission name. Valid options: ${VALID_PERMS.join(', ')}`, ephemeral: true });
      return;
    }

    const store = await loadStore();
    if (!store.guilds[interaction.guildId]) {
      store.guilds[interaction.guildId] = {
        apiKey: generateKey(),
        requiredPermission: requestedPerm,
        createdAt: Date.now()
      };
    } else {
      store.guilds[interaction.guildId].requiredPermission = requestedPerm;
    }
    await saveStore(store);

    await interaction.reply({
      content: `API key for this server:\n\`${store.guilds[interaction.guildId].apiKey}\`\nPermission required to use commands: **${requestedPerm}**`,
      ephemeral: true
    });
    
  } else if (interaction.commandName === 'announce') {
    const key = await (async () => {
      const store = await loadStore();
      return store.guilds[interaction.guildId]?.apiKey;
    })();

    if (!key) {
      await interaction.reply({ content: 'This server is not set up. Use /setup first.', ephemeral: true });
      return;
    }

    const store = await loadStore();
    const guildData = store.guilds[interaction.guildId];
    if (!guildData) {
      await interaction.reply({ content: 'Server data missing. Please run /setup.', ephemeral: true });
      return;
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits[guildData.requiredPermission])) {
      await interaction.reply({ content: `You lack the permission ${guildData.requiredPermission}`, ephemeral: true });
      return;
    }

    const type = interaction.options.getString('type');
    const title = interaction.options.getString('title');
    const message = interaction.options.getString('message');

    store.broadcasts[key] = {
      id: Date.now().toString(),
      type,
      title,
      message,
      timestamp: Date.now(),
    };
    await saveStore(store);

    await interaction.reply({ content: 'Broadcast message sent to the game.', ephemeral: true });
  }

  else if (interaction.commandName === 'kick') {
  const key = await (async () => {
    const store = await loadStore();
    return store.guilds[interaction.guildId]?.apiKey;
  })();

  if (!key) {
    await interaction.reply({ content: 'This server is not set up. Use /setup first.', ephemeral: true });
    return;
  }

  const store = await loadStore();
  const guildData = store.guilds[interaction.guildId];
  if (!guildData) {
    await interaction.reply({ content: 'Server data missing. Please run /setup.', ephemeral: true });
    return;
  }

  if (!interaction.member.permissions.has(PermissionFlagsBits[guildData.requiredPermission])) {
    await interaction.reply({ content: `You lack the permission ${guildData.requiredPermission}`, ephemeral: true });
    return;
  }

  const username = interaction.options.getString('username');
  const reason = interaction.options.getString('reason') || 'No reason provided';

  try {
    const response = await fetch(`https://essentials.up.railway.app/kick`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key
      },
      body: JSON.stringify({ targetUsername: username, reason })
    });

    if (!response.ok) {
      const error = await response.json();
      await interaction.reply({ content: `Kick failed: ${error.error}`, ephemeral: true });
      return;
    }

    await interaction.reply({ content: `Kick queued for **${username}** with reason: ${reason}`, ephemeral: true });
  } catch (err) {
    console.error('Kick command error:', err);
    await interaction.reply({ content: 'Failed to contact the backend.', ephemeral: true });
  }
}
});

client.login(token);
