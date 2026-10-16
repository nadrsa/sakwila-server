const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

const TOKEN = process.env.WA_TOKEN;
const PHONE_ID = process.env.WA_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'SakwilaSecret2025';

const RULES_FILE = './rules.json';
const SETTINGS_FILE = './settings.json';

function loadRules() {
  try { return JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8')); }
  catch { return []; }
}
function saveRules(rules) {
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')); }
  catch { return { botEnabled: true }; }
}
function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

async function sendWhatsApp(to, text) {
  await axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: to.replace('+', ''),
      type: 'text',
      text: { body: text }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
}

// ===== التحقق =====
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// ===== الاستقبال: نؤكد لميتا فوراً ثم نعالج في الخلفية =====
app.post('/webhook', (req, res) => {
  res.sendStatus(200);   // ← الإجابة الفورية = ميتا لن تعيد الإرسال أبداً

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const messages = value?.messages;
  if (!messages) return;

  (async () => {
    try {
      const settings = loadSettings();
      if (!settings.botEnabled) return;

      for (const msg of messages) {
        if (msg.type !== 'text') continue;
        const from = msg.from;
        const name = value.contacts?.[0]?.profile?.name || '';
        const text = msg.text.body;

        fs.appendFileSync('./messages_log.txt',
          `[${new Date().toLocaleString()}] ${name} (${from}): ${text}\n`);

        const rules = loadRules().filter(r => r.enabled);
        const rule = rules.find(r => text.includes(r.trigger));

        if (rule) {
          await sendWhatsApp(from, rule.response);
        } else {
          await sendWhatsApp(from,
            'شكراً على رسالتك 🙏\nاكتب سؤالك مباشرة،' +
            '\nأو جرّب التطبيق مجاناً: https://sakwila.app');
          fs.appendFileSync('./needs_reply.txt',
            `[${new Date().toLocaleString()}] ${name} (${from}): ${text}\n`);
        }
      }
    } catch (e) {
      console.error(e);
    }
  })();
});

// ===== جسر الإرسال =====
app.post('/api/send', async (req, res) => {
  const { phone, message } = req.body;
  try {
    await sendWhatsApp(phone, message);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.response?.data || e.message });
  }
});

// ===== القواعد =====
app.get('/api/rules', (req, res) => res.json(loadRules()));
app.post('/api/rules', (req, res) => {
  saveRules(req.body);
  res.json({ success: true, count: req.body.length });
});

// ===== الإعدادات =====
app.get('/api/settings', (req, res) => res.json(loadSettings()));
app.post('/api/settings', (req, res) => {
  saveSettings({ botEnabled: req.body.botEnabled });
  res.json({ success: true });
});

// ===== السجلات =====
app.get('/api/inbox', (req, res) => {
  try {
    res.type('text/plain').send(fs.readFileSync('./messages_log.txt', 'utf-8'));
  } catch { res.send(''); }
});

app.get('/api/needs-reply', (req, res) => {
  try {
    res.type('text/plain').send(fs.readFileSync('./needs_reply.txt', 'utf-8'));
  } catch { res.send(''); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 البوت يعمل على المنفذ ${PORT}`));
