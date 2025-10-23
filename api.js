import express from 'express';
import bodyParser from 'body-parser';
import fs from 'node:fs';

const app = express();
app.use(bodyParser.json());

let db = {};
if (fs.existsSync('./db.json')) db = JSON.parse(fs.readFileSync('./db.json', 'utf8'));
function saveDB() {
  fs.writeFileSync('./db.json', JSON.stringify(db, null, 2));
}

app.post('/announce', (req, res) => {
  const { guildId, apiKey, message, title, universeId } = req.body;
  const guild = db[guildId];
  if (!guild || guild.apiKey !== apiKey) {
    return res.status(403).json({ error: 'Invalid API key or guild not linked' });
  }
  console.log(`Announcement from ${guildId}: ${title} - ${message} (Universe ${universeId})`);
  return res.json({ success: true, received: { title, message, universeId } });
});

app.get('/', (req, res) => res.send('API running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API on port ${PORT}`));
