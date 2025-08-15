const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, Events, PermissionFlagsBits } = require('discord.js');
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

function generateKey() {
  return crypto.randomBytes(24).toString('hex');
}

async function loadStore() {
  const doc = await db.collection('store').doc('data').get();
  if (!doc.exists) return { guilds: {}, broadcasts: {}, kicks: {}, shutdowns: {}, serverbans: {}, permbans: {} };
  const data = doc.data();
  data.shutdowns = data.shutdowns || {};
  data.kicks = data.kicks || {};
  data.serverbans = data.serverbans || {};
  data.permbans = data.permbans || {};
  return data;
}

async function saveStore(store) {
  await db.collection('store').doc('data').set(store);
}

const app = express();
app.use(cors());
app.use(bodyParser.json());

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

const announceCommand = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Send an announcement to Roblox players')
  .addStringOption(option => 
    option.setName('message')
          .setDescription('Message to announce')
          .setRequired(true)
  )
  .addStringOption(option => 
    option.setName('title')
          .setDescription('Title of the announcement')
          .setRequired(false)
  );

const kickCommand = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kick a Roblox user')
  .addStringOption(option => option.setName('username').setDescription('Roblox username').setRequired(true))
  .addStringOption(option => option.setName('reason').setDescription('Reason').setRequired(false));

const serverBanCommand = new SlashCommandBuilder()
  .setName('serverban')
  .setDescription('Ban a Roblox user from the current game server only')
  .addStringOption(option => option.setName('username').setDescription('Roblox username').setRequired(true))
  .addStringOption(option => option.setName('reason').setDescription('Reason').setRequired(false));

const permBanCommand = new SlashCommandBuilder()
  .setName('permban')
  .setDescription('Ban a Roblox user from all servers')
  .addStringOption(option => option.setName('username').setDescription('Roblox username').setRequired(true))
  .addStringOption(option => option.setName('reason').setDescription('Reason').setRequired(false));

const shutdownCommand = new SlashCommandBuilder()
  .setName('shutdown')
  .setDescription('Shutdown a specific Roblox server (by JobId)')
  .addStringOption(option => option.setName('jobid').setDescription('Roblox JobId').setRequired(true))
  .addStringOption(option => option.setName('reason').setDescription('Reason').setRequired(false));

const rest = new REST({ version: '10' }).setToken(token);

async function RegisterGlobalCommands() {
  const commandsToRegister = [
  setupCommand.toJSON(),
  kickCommand.toJSON(),
  serverBanCommand.toJSON(),
  permBanCommand.toJSON(),
  shutdownCommand.toJSON(),
  announceCommand.toJSON()
];
  await rest.put(Routes.applicationCommands(clientId), { body: commandsToRegister });
}

app.post('/api/kick', requireBasicAuth, async (req, res) => {
  const { targetUsername, reason } = req.body;
  if (!targetUsername) return res.status(400).json({ error: "targetUsername required" });

  const store = await loadStore();
  const key = req.headers['x-api-key'];
  if (!store.guilds[key]) return res.status(403).json({ error: "Invalid API key" });

  store.kicks[key] = { id: Date.now().toString(), targetUsername, reason, timestamp: Date.now() };
  await saveStore(store);
  res.json({ success: true });
});

app.get('/api/kick/latest/public', async (req, res) => {
  const key = req.query.key;
  const store = await loadStore();
  res.json(store.kicks[key] || { id: null });
});

app.post('/api/serverban', requireBasicAuth, async (req, res) => {
  const { targetUsername, reason, jobId } = req.body;
  if (!targetUsername || !jobId) return res.status(400).json({ error: "targetUsername & jobId required" });

  const store = await loadStore();
  const key = req.headers['x-api-key'];
  if (!store.guilds[key]) return res.status(403).json({ error: "Invalid API key" });

  store.serverbans[key] = { id: Date.now().toString(), targetUsername, reason, jobId, timestamp: Date.now() };
  await saveStore(store);
  res.json({ success: true });
});

app.get('/api/serverban/latest/public', async (req, res) => {
  const key = req.query.key;
  const store = await loadStore();
  res.json(store.serverbans[key] || { id: null });
});

app.post('/api/permban', requireBasicAuth, async (req, res) => {
  const { targetUsername, reason } = req.body;
  if (!targetUsername) return res.status(400).json({ error: "targetUsername required" });

  const store = await loadStore();
  const key = req.headers['x-api-key'];
  if (!store.guilds[key]) return res.status(403).json({ error: "Invalid API key" });

  store.permbans[key] = store.permbans[key] || {};
  store.permbans[key][targetUsername.toLowerCase()] = { reason, timestamp: Date.now() };
  await saveStore(store);
  res.json({ success: true });
});

app.post('/api/announce', requireBasicAuth, async (req, res) => {
  const { message, hint } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });

  const store = await loadStore();
  const key = req.headers['x-api-key'];
  if (!store.guilds[key]) return res.status(403).json({ error: "Invalid API key" });

  store.broadcasts[key] = { id: Date.now().toString(), message, hint, timestamp: Date.now() };
  await saveStore(store);
  res.json({ success: true });
});

app.get('/api/latest', async (req, res) => {
  const key = req.query.key;
  const store = await loadStore();
  res.json(store.broadcasts[key] || { id: null });
});

app.get('/api/permban/list', async (req, res) => {
  const key = req.query.key;
  const store = await loadStore();
  res.json(store.permbans[key] || {});
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const store = await loadStore();
  const guildData = store.guilds[interaction.guildId];
  if (!guildData) return interaction.reply({ content: 'Not set up. Use /setup first.', ephemeral: true });
  if (!interaction.member.permissions.has(PermissionFlagsBits[guildData.requiredPermission])) {
    return interaction.reply({ content: 'Missing permission.', ephemeral: true });
  }

  const key = guildData.apiKey;
  const basicAuth = Buffer.from(`${process.env.KEYS_USER}:${process.env.KEYS_PASS}`).toString('base64');
  const send = async (endpoint, body) => {
    const res = await fetch('https://essentials.up.railway.app/api/${endpoint}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'Authorization': 'Basic ${basicAuth}' },
      body: JSON.stringify(body)
    });
    return res.ok ? res.json() : { error: await res.text() };
  };

  if (interaction.commandName === 'kick') {
    const u = interaction.options.getString('username');
    const r = interaction.options.getString('reason') || 'No reason';
    await send('kick', { targetUsername: u, reason: r });
    return interaction.reply({ content: 'Kicked ${u}'., ephemeral: true });
  }
  if (interaction.commandName === 'serverban') {
    const u = interaction.options.getString('username');
    const r = interaction.options.getString('reason') || 'No reason';
    await send('serverban', { targetUsername: u, reason: r, jobId: interaction.guildId });
    return interaction.reply({ content: Server banned ${u}., ephemeral: true });
  }
  if (interaction.commandName === 'permban') {
    const u = interaction.options.getString('username');
    const r = interaction.options.getString('reason') || 'No reason';
    await send('permban', { targetUsername: u, reason: r });
    return interaction.reply({ content: Perm banned ${u}., ephemeral: true });
  }
if (interaction.commandName === 'announce') {
  const message = interaction.options.getString('message');
  const title = interaction.options.getString('title') || 'Announcement';
  await send('announce', { message, title });
  return interaction.reply({ content: `Announcement sent.`, ephemeral: true });
}
const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Generate/view this server’s API key and choose the required permission for commands')
  .addStringOption(option =>
    option.setName('permission')
      .setDescription('Discord permission required to use commands')
      .setRequired(true)
      .setAutocomplete(true)
  );

});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(Server running on ${PORT}));

(async () => {
  await RegisterGlobalCommands();
  client.login(token);
})();
