const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

// ===== الإعدادات =====
const TOKEN = process.env.WA_TOKEN;
const PHONE_ID = process.env.WA_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'SakwilaSecret2025';

// ===== القواعد =====
const RULES_FILE = './rules.json';

function loadRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveRules(rules) {
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
}

// ===== الإعدادات (زر تشغيل البوت) =====
const SETTINGS_FILE = './settings.json';

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return { botEnabled: true };
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

// ===== إرسال رسالة =====
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

// ===== ① الويبهوك: التحقق =====
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// ===== ② الويبهوك: استقبال + بوت =====
app.post('/webhook', async (req, res) => {
  try {
    const settings = loadSettings();
    if (!settings.botEnabled) {
      return res.sendStatus(200);
    }

    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages;

    if (messages) {
      for (const msg of messages) {
        if (msg.type !== 'text') continue;
        const from = msg.from;
        const name = value.contacts?.[0]?.profile?.name || '';
        const text = msg.text.body;

        const line = `[${new Date().toLocaleString()}] ${name} (${from}): ${text}\n`;
        fs.appendFileSync('./messages_log.txt', line);

        const rules = loadRules().filter(r => r.enabled);
        const rule = rules.find(r => text.includes(r.trigger));

        if (rule) {
          await sendWhatsApp(from, rule.response);
        } else {
          await sendWhatsApp(from,
            'شكراً على رسالتك 🙏\nاكتب سؤالك مباشرة،' +
            '\nأو جرّب التطبيق مجاناً: https://sakwila.app');
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

// ===== ③ جسر الإرسال =====
app.post('/api/send', async (req, res) => {
  const { phone, message } = req.body;
  try {
    await sendWhatsApp(phone, message);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.response?.data || e.message });
  }
});

// ===== ④ القواعد =====
app.get('/api/rules', (req, res) => res.json(loadRules()));

app.post('/api/rules', (req, res) => {
  saveRules(req.body);
  res.json({ success: true, count: req.body.length });
});

// ===== ⑤ الإعدادات =====
app.get('/api/settings', (req, res) => res.json(loadSettings()));

app.post('/api/settings', (req, res) => {
  saveSettings({ botEnabled: req.body.botEnabled });
  res.json({ success: true });
});

// ===== ⑥ صندوق الوارد =====
app.get('/api/inbox', (req, res) => {
  try {
    const log = fs.readFileSync('./messages_log.txt', 'utf-8');
    res.type('text/plain').send(log);
  } catch {
    res.send('');
  }
});

// ===== 🆕 عدسة التشخيص =====
app.get('/api/debug', (req, res) => {
  const t = process.env.WA_TOKEN || '';
  res.json({
    token_found: t.length > 0,
    token_length: t.length,
    first_6: t.substring(0, 6),
    last_6: t.substring(t.length - 6),
    phone_id: process.env.WA_PHONE_ID || 'NOT FOUND'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 البوت يعمل على المنفذ ${PORT}`));
