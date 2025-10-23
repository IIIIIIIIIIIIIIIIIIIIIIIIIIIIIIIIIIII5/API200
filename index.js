import { Client, GatewayIntentBits, Collection } from 'discord.js';
import fs from 'node:fs';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
for (const file of commandFiles) {
  const command = await import(`./commands/${file}`);
  client.commands.set(command.default.data.name, command.default);
}

let db = {};
if (fs.existsSync('./db.json')) db = JSON.parse(fs.readFileSync('./db.json', 'utf8'));
function saveDB() {
  fs.writeFileSync('./db.json', JSON.stringify(db, null, 2));
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.default.execute(interaction, db, saveDB);
  } catch (error) {
    console.error(error);
    await interaction.reply({
      content: 'Error executing command.',
      ephemeral: true,
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
