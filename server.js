/* Sakwila server — v2 (r4: تتبع حالات الرسائل sent → delivered → read / failed)
   تغييرات عن النسخة القديمة (معلَّمة بـ // r4):
   1) POST /webhook: معالجة statuses بجانب messages (كانت تُتجاهل).
   2) /api/send يخزّن كل إرسال في __sync__.statuses ويعيد message_id.
   3) قاعدة بيانات رسائل نصية منفصلة (messages.json) — نسخة احتياطية دائمة.
   الباقي كما هو حرفيًا. */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cors());

const TOKEN = process.env.WA_TOKEN;
const PHONE_ID = process.env.WA_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'SakwilaSecret2025';

const RULES_FILE = './rules.json';
const SETTINGS_FILE = './settings.json';
const DB_FILE = './messages.json'; // r4: قاعدة الحالات + الإرسالات

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

// ===== r4: قاعدة الرسائل (الإرسالات + الحالات) =====
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); }
  catch { return { statuses: {}, sends: [] }; }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
}
function getSyncRule(rules) {
  return rules.find(r => r.id === '__sync__' || r.trigger === '__sync__');
}
function decodeSync(rule) {
  try { return JSON.parse(Buffer.from(rule.response, 'base64').toString('utf-8')); }
  catch { return null; }
}
function encodeSync(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64');
}
// r4: دمج الحالات محليًا ثم دفعها لقاعدة القواعد (__sync__.statuses) — مصدر واحد
function mergeStatuses(localSt, remoteSt) {
  const merged = { ...(remoteSt || {}) };
  const rank = { failed: 0, sent: 1, delivered: 2, read: 3 };
  for (const id in (localSt || {})) {
    const a = localSt[id], b = merged[id];
    const ar = rank[a.status] ?? -1, br = rank[b?.status] ?? -1;
    if (!b || ar >= br) merged[id] = a;
  }
  return merged;
}
// r4: كتابة حالة داخل __sync__ + messages.json (محاولة واحدة كاملة؛ الأخطاء لا تكسر webhook)
function persistStatuses(newLocal) {
  try {
    const rules = loadRules();
    const rule = getSyncRule(rules);
    let sync = rule ? decodeSync(rule) : null;
    if (!sync || typeof sync !== 'object' || !sync.logs) {
      sync = { v: 1, logs: {}, marks: {}, drafts: {}, fdone: {}, statuses: {} };
    }
    sync.statuses = mergeStatuses(newLocal, sync.statuses);
    if (rule) rule.response = encodeSync(sync);
    else rules.push({ id: '__sync__', trigger: '__sync__', response: encodeSync(sync), enabled: false });
    saveRules(rules);

    const db = loadDB();
    db.statuses = mergeStatuses(newLocal, db.statuses);
    saveDB(db);
  } catch (e) {
    console.error('persistStatuses:', e.message);
  }
}

async function sendWhatsApp(to, text) {
  const resp = await axios.post(
    `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: to.replace('+', ''),
      type: 'text',
      text: { body: text }
    },
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
  return resp.data; // r4: نعيد جسم ميتا (فيه wamid)
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

  // ===== r4: معالجة حالات التسليم (statuses) — كانت تُتجاهل سابقًا =====
  const statuses = value?.statuses;
  if (statuses) {
    (async () => {
      try {
        const newLocal = {};
        for (const st of statuses) {
          newLocal[st.id] = {
            status: st.status,                    // sent | delivered | read | failed
            ts: (Number(st.timestamp) || 0) * 1000 || Date.now(),
            phone: st.recipient_id || '',
            errs: st.errors ? JSON.stringify(st.errors).slice(0, 300) : '',
            upt: Date.now()
          };
        }
        persistStatuses(newLocal);
        fs.appendFileSync('./statuses_log.txt',
          `[${new Date().toLocaleString()}] ${JSON.stringify(statuses)}\n`);
      } catch (e) { console.error('statuses handler:', e.message); }
    })();
  }

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

        let sentText = '';
        if (rule) {
          sentText = rule.response;
        } else {
          sentText = 'شكراً على رسالتك 🙏\nاكتب سؤالك مباشرة،' +
            '\nأو جرّب التطبيق مجاناً: https://sakwila.app';
          fs.appendFileSync('./needs_reply.txt',
            `[${new Date().toLocaleString()}] ${name} (${from}): ${text}\n`);
        }
        // r4: نلتقط wamid ونسجل الإرسال فورًا كـ sent
        try {
          const waResp = await sendWhatsApp(from, sentText);
          const mid = waResp?.messages?.[0]?.id;
          if (mid) persistStatuses({ [mid]: { status: 'sent', ts: Date.now(), phone: from, errs: '', upt: Date.now() } });
        } catch (e) {
          console.error('send in webhook:', e.message);
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
    const waResp = await sendWhatsApp(phone, message);
    const mid = waResp?.messages?.[0]?.id; // r4: wamid من ميتا
    if (mid) {
      persistStatuses({ [mid]: { status: 'sent', ts: Date.now(), phone: phone.replace('+', ''), errs: '', upt: Date.now() } });
    }
    res.json({ success: true, message_id: mid || null }); // r4: الأداة r4 تلتقطه
  } catch (e) {
    res.json({ success: false, error: e.response?.data || e.message });
  }
});

// ===== القواعد =====
app.get('/api/rules', (req, res) => res.json(loadRules()));
app.post('/api/rules', (req, res) => {
  // r4: حماية — إن غاب __sync__ من الحمولة نحافظ على الموجود حاليًا على السيرفر
  const incoming = req.body;
  const hasSync = Array.isArray(incoming) && incoming.some(r => r.id === '__sync__' || r.trigger === '__sync__');
  if (Array.isArray(incoming) && !hasSync) {
    const cur = getSyncRule(loadRules());
    if (cur) incoming.push(cur);
  }
  saveRules(incoming);
  res.json({ success: true, count: incoming.length });
});

// ===== r4: واجهة الحالات للأداة (قراءة مباشرة، بلا فك base64) =====
app.get('/api/statuses', (req, res) => {
  res.json(loadDB().statuses || {});
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
app.listen(PORT, () => console.log(`🚀 البوت يعمل على المنفذ ${PORT} (r4: تتبع الحالات مفعّل)`));
