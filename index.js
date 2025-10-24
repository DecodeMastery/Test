import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

const {
  DISCORD_TOKEN,
  SHARED_TOKEN,
  ACTIVE_TTL = 45,
  ALLOWED_COMMAND_USER_IDS = ''
} = process.env;

// Render injects its own dynamic port at runtime
const PORT = process.env.PORT || 4000;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in Environment tab');
  process.exit(1);
}
if (!SHARED_TOKEN) {
  console.error('Missing SHARED_TOKEN in Environment tab');
  process.exit(1);
}

const ACTIVE_TTL_MS = Number(ACTIVE_TTL) * 1000;

// ---------------------------------------------
// In-memory presence table: user => { lastSeen }
// ---------------------------------------------
/** @type {Map<string, { lastSeen: number }>} */
const active = new Map();

function cleanupStale() {
  const now = Date.now();
  for (const [user, info] of active) {
    if (now - info.lastSeen > ACTIVE_TTL_MS) {
      active.delete(user);
    }
  }
}

function listOnline() {
  cleanupStale();
  return [...active.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([user, info]) => ({ user, lastSeen: info.lastSeen }));
}

function tsRel(dateMs) {
  // Discord relative timestamp: <t:unix:R>
  return `<t:${Math.floor(dateMs / 1000)}:R>`;
}

// ---------------------------------------------
// HTTP server: clients POST /status
// ---------------------------------------------
const app = express();
app.use(express.json());

// health / uptime
app.get('/health', (_req, res) =>
  res.json({ ok: true, online: listOnline().length })
);

app.post('/status', (req, res) => {
  try {
    const key = req.header('x-agent-key') || req.body?.token;
    if (key !== SHARED_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const userRaw = (req.body?.user ?? '').toString().trim();
    const stateRaw = (req.body?.state ?? 'online').toString().toLowerCase();

    if (!userRaw) {
      return res.status(400).json({ ok: false, error: 'missing user' });
    }

    if (stateRaw === 'offline') {
      active.delete(userRaw);
      return res.json({ ok: true, status: 'offline', user: userRaw });
    }

    // Online or heartbeat
    active.set(userRaw, { lastSeen: Date.now() });
    return res.json({
      ok: true,
      status: 'online',
      user: userRaw,
      ttlSec: Number(ACTIVE_TTL)
    });
  } catch (e) {
    console.error('POST /status error:', e);
    res.status(500).json({ ok: false, error: 'server' });
  }
});

// ✅ FIXED FOR RENDER: use dynamic port variable
app.listen(PORT, () => {
  console.log(`[HTTP] Listening on :${PORT}`);
});

// ---------------------------------------------
// Discord Bot: responds to !status in channels
// ---------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const allowedIds = new Set(
  ALLOWED_COMMAND_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean)
);

client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.content.trim().toLowerCase() !== '!status') return;

    if (allowedIds.size && !allowedIds.has(msg.author.id)) {
      return msg.reply("🚫 You don't have permission to use this command.");
    }

    const rows = listOnline();
    if (rows.length === 0) {
      return msg.reply('⚪ No clients online.');
    }

    const lines = rows.map(
      (r, i) => `${i + 1}. **${r.user}** — last ping ${tsRel(r.lastSeen)}`
    );
    const reply = `🟢 **${rows.length}** client(s) online:\n${lines.join(
      '\n'
    )}\n_Entries expire if no heartbeat in ${ACTIVE_TTL}s._`;

    return msg.reply(reply);
  } catch (e) {
    console.error('messageCreate error:', e);
  }
});

client.once('ready', () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('Discord login failed:', err);
  process.exit(1);
});

// Optional: periodic cleanup
setInterval(cleanupStale, 10_000);
