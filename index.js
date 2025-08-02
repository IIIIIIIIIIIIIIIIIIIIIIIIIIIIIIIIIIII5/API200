const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, Events } = require('discord.js');

const app = express();
app.use(cors());
app.use(bodyParser.json());

let latestMessage = null;

const WHITELISTED_USERS = [
  '1167121753672257576',
  '1013186507919593542'
];

app.post('/send', (req, res) => {
  const { type, title, message } = req.body;
  if (!type || !title || !message) return res.status(400).json({ error: 'Missing fields' });

  latestMessage = {
    id: Date.now().toString(),
    type,
    title,
    message,
    timestamp: Date.now()
  };

  console.log('[API] New broadcast stored:', latestMessage);
  return res.json({ success: true });
});

app.get('/latest', (req, res) => {
  if (!latestMessage) return res.status(204).send();
  res.json(latestMessage);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API server running on port ${PORT}`));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const broadcastCommand = new SlashCommandBuilder()
  .setName('broadcast')
  .setDescription('Send a message to all Roblox players')
  .addStringOption(option =>
    option.setName('type')
      .setDescription('Type of message')
      .setRequired(true)
      .addChoices(
        { name: 'Message', value: 'Message' },
        { name: 'Hint', value: 'Hint' },
        { name: 'List', value: 'List' },
        { name: 'Notif', value: 'Notif' }
      ))
  .addStringOption(option =>
    option.setName('title')
      .setDescription('Title of the broadcast')
      .setRequired(true))
  .addStringOption(option =>
    option.setName('message')
      .setDescription('Message body')
      .setRequired(true));

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: [broadcastCommand.toJSON()] }
    );
    console.log('Slash command registered.');
  } catch (err) {
    console.error('Failed to register slash command:', err);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'broadcast') return;

  if (!WHITELISTED_USERS.includes(interaction.user.id)) {
    return interaction.reply({ content: 'You are not authorized to use this command.', ephemeral: true });
  }

  const type = interaction.options.getString('type');
  const title = interaction.options.getString('title');
  const message = interaction.options.getString('message');

  try {
    const resp = await fetch(`${process.env.API_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, title, message })
    });

    if (!resp.ok) {
      throw new Error(`API responded with status ${resp.status}`);
    }

    await interaction.reply(`Announcement sent!\n**${type}**: ${title}`);
  } catch (err) {
    console.error('Error sending broadcast to API:', err);
    await interaction.reply({ content: 'Failed to send announcement.', ephemeral: true });
  }
});

client.login(process.env.BOT_TOKEN);
