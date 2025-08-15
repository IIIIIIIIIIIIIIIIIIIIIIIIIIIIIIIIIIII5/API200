const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, Events, PermissionFlagsBits } = require('discord.js');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp({
  credential: admin.credential.cert({
    project_id: process.env.PROJECTID,
    client_email: process.env.CLIENTEMAIL,
    private_key: process.env.PRIVATEKEY.replace(/\\n/g, '\n'),
  }),
});

const db = admin.firestore();
const token = process.env.BOT_TOKEN;
const clientId = process.env.CLIENT_ID;

async function loadStore() {
  const doc = await db.collection('store').doc('data').get();
  if (!doc.exists) return { guilds: {}, broadcasts: {}, kicks: {}, shutdowns: {}, serverbans: {}, permbans: {} };
  const data = doc.data();
  data.broadcasts = data.broadcasts || {};
  data.kicks = data.kicks || {};
  data.shutdowns = data.shutdowns || {};
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
  if (!auth || !auth.startsWith('Basic ')) return res.status(401).json({ error: 'Authentication required' });
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (user === process.env.KEYS_USER && pass === process.env.KEYS_PASS) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const announceCommand = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Send an announcement to Roblox players')
  .addStringOption(option => option.setName('message').setDescription('Message').setRequired(true))
  .addStringOption(option => option.setName('hint').setDescription('Hint').setRequired(false));

const kickCommand = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kick a Roblox user')
  .addStringOption(option => option.setName('username').setDescription('Username').setRequired(true))
  .addStringOption(option => option.setName('reason').setDescription('Reason'));

const serverBanCommand = new SlashCommandBuilder()
  .setName('serverban')
  .setDescription('Server ban a Roblox user')
  .addStringOption(option => option.setName('username').setDescription('Username').setRequired(true))
  .addStringOption(option => option.setName('reason').setDescription('Reason'));

const permBanCommand = new SlashCommandBuilder()
  .setName('permban')
  .setDescription('Perm ban a Roblox user')
  .addStringOption(option => option.setName('username').setDescription('Username').setRequired(true))
  .addStringOption(option => option.setName('reason').setDescription('Reason'));

const shutdownCommand = new SlashCommandBuilder()
  .setName('shutdown')
  .setDescription('Shutdown a Roblox server by JobId')
  .addStringOption(option => option.setName('jobid').setDescription('JobId').setRequired(true))
  .addStringOption(option => option.setName('reason').setDescription('Reason'));

const rest = new REST({ version: '10' }).setToken(token);

async function registerCommands() {
  await rest.put(Routes.applicationCommands(clientId), { body: [
    announceCommand.toJSON(),
    kickCommand.toJSON(),
    serverBanCommand.toJSON(),
    permBanCommand.toJSON(),
    shutdownCommand.toJSON()
  ]});
}

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

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const store = await loadStore();
  const key = process.env.DISCORD_API_KEY;

  if (interaction.commandName === 'announce') {
    const message = interaction.options.getString('message');
    const hint = interaction.options.getString('hint') || '';
    store.broadcasts[key] = { id: Date.now().toString(), message, hint, timestamp: Date.now() };
    await saveStore(store);
    await interaction.reply({ content: `Announcement sent!`, ephemeral: true });
  }

  if (interaction.commandName === 'kick') {
    const username = interaction.options.getString('username');
    const reason = interaction.options.getString('reason') || "No reason";
    store.kicks[key] = { id: Date.now().toString(), targetUsername: username, reason, timestamp: Date.now() };
    await saveStore(store);
    await interaction.reply({ content: `Kicked ${username}`, ephemeral: true });
  }

  if (interaction.commandName === 'serverban') {
    const username = interaction.options.getString('username');
    const reason = interaction.options.getString('reason') || "No reason";
    store.serverbans[key] = { id: Date.now().toString(), targetUsername: username, reason, timestamp: Date.now() };
    await saveStore(store);
    await interaction.reply({ content: `Server banned ${username}`, ephemeral: true });
  }

  if (interaction.commandName === 'permban') {
    const username = interaction.options.getString('username');
    const reason = interaction.options.getString('reason') || "No reason";
    store.permbans[key] = { id: Date.now().toString(), targetUsername: username, reason, timestamp: Date.now() };
    await saveStore(store);
    await interaction.reply({ content: `Perm banned ${username}`, ephemeral: true });
  }

  if (interaction.commandName === 'shutdown') {
    const jobId = interaction.options.getString('jobid');
    const reason = interaction.options.getString('reason') || "No reason";
    store.shutdowns[key] = { id: Date.now().toString(), jobId, reason, timestamp: Date.now() };
    await saveStore(store);
    await interaction.reply({ content: `Shutdown sent for JobId ${jobId}`, ephemeral: true });
  }
});

client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));
registerCommands();
client.login(token);

app.listen(3000, () => console.log('API running on port 3000'));
