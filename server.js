const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

// ===== الإعدادات من متغيرات Railway (لا شيء مكشوف في الكود) =====
const TOKEN = process.env.WA_TOKEN;
const PHONE_ID = process.env.WA_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'SakwilaSecret2025';

// ===== تخزين قواعد البوت =====
const RULES_FILE = './rules.json';
function loadRules() {
  try { return JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8')); }
  catch { return []; }
}
function saveRules(rules) {
  fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
}

// ===== إرسال رسالة واتساب =====
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

// ===== ② الويبهوك: استقبال الرسائل + منطق البوت =====
app.post('/webhook', async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages;

    if (messages) {
      for (const msg of messages) {
        if (msg.type !== 'text') continue;
        const from = msg.from;
        const name = value.contacts?.[0]?.profile?.name || '';
        const text = msg.text.body;

        // 📝 سجل الرسائل
        const line = `[${new Date().toLocaleString()}] ${name} (${from}): ${text}\n`;
        fs.appendFileSync('./messages_log.txt', line);

        // 🤖 البحث عن قاعدة مطابقة
        const rules = loadRules().filter(r => r.enabled);
        const rule = rules.find(r => text.includes(r.trigger));

        if (rule) {
          await sendWhatsApp(from, rule.response);
        } else {
          await sendWhatsApp(from,
            'شكراً على رسالتك 🙏\nاكتب سؤالك مباشرة وسنجيبك،' +
            '\nأو جرّب التطبيق مجاناً: https://sakwila.app');
        }
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);  // ⚠️ دائماً 200
  }
});

// ===== ③ جسر الإرسال لتطبيقك (يحل CORS!) =====
app.post('/api/send', async (req, res) => {
  const { phone, message } = req.body;
  try {
    await sendWhatsApp(phone, message);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.response?.data || e.message });
  }
});

// ===== ④ مزامنة قواعد البوت مع الواجهة =====
app.get('/api/rules', (req, res) => res.json(loadRules()));

app.post('/api/rules', (req, res) => {
  saveRules(req.body);
  res.json({ success: true, count: req.body.length });
});

// ===== ⑤ صندوق الوارد (لواجهتك مستقبلاً) =====
app.get('/api/inbox', (req, res) => {
  try {
    const log = fs.readFileSync('./messages_log.txt', 'utf-8');
    res.type('text/plain').send(log);
  } catch { res.send(''); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 البوت يعمل على المنفذ ${PORT}`));