const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { 
  Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, Events, PermissionFlagsBits 
} = require('discord.js');
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
const clientId = process.env.CLIENT_ID;
console.log("Token is:", token ? "set" : "NOT set");

const ESSENTIALS_API_BASE = 'https://essentials.up.railway.app';

function generateKey() {
  return crypto.randomBytes(24).toString('hex');
}

function extractKey(req) {
  return req.header('x-api-key') || req.query.key;
}

function formatReadable(ts) {
  if (!ts) return null;
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
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
  } catch (e) {
    return res.status(400).json({ error: 'Bad auth header' });
  }
  const [user, pass] = decoded.split(':');
  if (user === process.env.KEYS_USER && pass === process.env.KEYS_PASS) {
    return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="keys"');
  return res.status(403).json({ error: 'Forbidden' });
}

async function loadStore() {
  const doc = await db.collection('store').doc('data').get();
  if (!doc.exists) return { guilds: {}, broadcasts: {}, kicks: {}, shutdowns: {} };
  const data = doc.data();
  data.shutdowns = data.shutdowns || {};
  return data;
}

async function saveStore(store) {
  await db.collection('store').doc('data').set(store);
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const VALID_PERMS = Object.keys(PermissionFlagsBits);

const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Generate/view this server’s API key and choose the required permission for commands')
  .addStringOption(option =>
    option.setName('permission')
      .setDescription('Discord permission required to use commands')
      .setRequired(true)
      .setAutocomplete(true)
  );

const broadcastCommand = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Send a message to all players in game')
  .addStringOption(option =>
    option.setName('type')
      .setDescription('Type of message')
      .setRequired(true)
      .addChoices(
        { name: 'hint', value: 'hint' },
        { name: 'message', value: 'message' }
      )
  )
  .addStringOption(option => option.setName('title').setDescription('Message title').setRequired(true))
  .addStringOption(option => option.setName('message').setDescription('Message body').setRequired(true));

const kickCommand = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kick a roblox user')
  .addStringOption(option => option.setName('username').setDescription('Roblox username to kick').setRequired(true))
  .addStringOption(option => option.setName('reason').setDescription('Reason for kick').setRequired(false));

const shutdownCommand = new SlashCommandBuilder()
  .setName('shutdown')
  .setDescription('Shutdown a specific Roblox server (by ServerId)')
  .addStringOption(option => option.setName('jobid').setDescription('Roblox JobId (server ID)').setRequired(true))
  .addStringOption(option => option.setName('reason').setDescription('Reason for shutdown').setRequired(false));

const rest = new REST({ version: '10' }).setToken(token);

async function RegisterGlobalCommands() {
  const commandsToRegister = [
    setupCommand.toJSON(),
    broadcastCommand.toJSON(),
    kickCommand.toJSON(),
    shutdownCommand.toJSON()
  ];

  try {
    const currentCommands = await rest.get(Routes.applicationCommands(clientId));
    
    const currentCommandsMap = new Map(currentCommands.map(cmd => [cmd.name, cmd]));
    let changed = false;

    if (currentCommands.length !== commandsToRegister.length) {
      changed = true;
    } else {
      for (const cmd of commandsToRegister) {
        const current = currentCommandsMap.get(cmd.name);
        if (!current || JSON.stringify(current) !== JSON.stringify(cmd)) {
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      await rest.put(Routes.applicationCommands(clientId), { body: commandsToRegister });
      console.log('Slash commands registered/updated.');
    } else {
      console.log('No changes in slash commands. Skipping.');
    }
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const store = await loadStore();
  const guildData = store.guilds[interaction.guildId];
  const key = guildData?.apiKey;

  if (interaction.commandName === 'setup') {
    const requestedPerm = interaction.options.getString('permission');
    if (!VALID_PERMS.includes(requestedPerm)) {
      await interaction.reply({ content: `Invalid permission. Valid: ${VALID_PERMS.join(', ')}`, ephemeral: true });
      return;
    }

    if (!guildData) {
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
      content: `API key:\n${store.guilds[interaction.guildId].apiKey}\nPermission: **${requestedPerm}**`,
      ephemeral: true
    });

    return;

  } else if (!guildData) {
    await interaction.reply({ content: 'This server is not set up. Use /setup first.', ephemeral: true });
    return;
  } else if (!interaction.member.permissions.has(PermissionFlagsBits[guildData.requiredPermission])) {
    await interaction.reply({ content: `Missing permission: ${guildData.requiredPermission}`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'kick') {
    const username = interaction.options.getString('username');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    if (!key) {
      await interaction.reply({ content: 'API key missing for this guild. Please run /setup.', ephemeral: true });
      return;
    }

    console.log('Kick command:', { username, reason, key });

    try {
      const response = await fetch(`${ESSENTIALS_API_BASE}/api/kick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ targetUsername: username, reason })
      });

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        const errorText = contentType && contentType.includes('application/json') 
          ? (await response.json()).error 
          : await response.text();
        console.log('Kick API error response:', errorText);
        await interaction.reply({ content: `Kick failed: ${errorText}`, ephemeral: true });
        return;
      }

      await interaction.reply({ content: `Kicked **${username}** for: ${reason}`, ephemeral: true });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: 'Failed to contact kick API.', ephemeral: true });
    }

  } else if (interaction.commandName === 'announce') {
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

    await interaction.reply({ content: 'Broadcast sent.', ephemeral: true });

  } else if (interaction.commandName === 'shutdown') {
    const jobId = interaction.options.getString('jobid');
    const reason = interaction.options.getString('reason') || 'No reason provided';

    try {
      const response = await fetch(`${ESSENTIALS_API_BASE}/api/shutdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({ jobId, reason })
      });

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        const error = contentType && contentType.includes('application/json') 
          ? (await response.json()).error 
          : await response.text();
        await interaction.reply({ content: `Shutdown failed: ${error}`, ephemeral: true });
        return;
      }

      await interaction.reply({ content: `Server **${jobId}** is shutting down.\nReason: ${reason}`, ephemeral: true });
    } catch (err) {
      console.error(err);
      await interaction.reply({ content: 'Failed to contact shutdown API.', ephemeral: true });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

(async () => {
  await RegisterGlobalCommands();
  client.login(token);
})();
