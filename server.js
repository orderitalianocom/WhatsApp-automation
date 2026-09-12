import express from "express";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "10mb" }));

const db = new Database(path.join(__dirname, "data", "rakibflow.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 wa_id TEXT UNIQUE NOT NULL,
 name TEXT,
 phone TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 contact_id INTEGER NOT NULL,
 last_message_at TEXT,
 unread_count INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'open',
 FOREIGN KEY(contact_id) REFERENCES contacts(id)
);
CREATE TABLE IF NOT EXISTS messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id INTEGER NOT NULL,
 wa_message_id TEXT UNIQUE,
 direction TEXT NOT NULL,
 type TEXT NOT NULL DEFAULT 'text',
 body TEXT,
 media_id TEXT,
 status TEXT,
 timestamp TEXT NOT NULL,
 raw_json TEXT,
 FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_contacts_wa ON contacts(wa_id);
`);

const now = () => new Date().toISOString();
const env = process.env;

function dashboardAuth(req, res, next) {
  const password = env.DASHBOARD_PASSWORD;
  if (!password) return next();
  const supplied = req.get("x-dashboard-password") || req.query.password;
  if (supplied === password) return next();
  return res.status(401).json({ error: "Dashboard authentication required" });
}

function upsertContact(waId, name = null) {
  const t = now();
  db.prepare(`
    INSERT INTO contacts(wa_id,name,phone,created_at,updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(wa_id) DO UPDATE SET
      name=COALESCE(excluded.name,contacts.name),
      phone=excluded.phone,
      updated_at=excluded.updated_at
  `).run(waId, name, waId, t, t);
  return db.prepare("SELECT * FROM contacts WHERE wa_id=?").get(waId);
}

function upsertConversation(contactId, lastMessageAt, unread = false) {
  let c = db.prepare("SELECT * FROM conversations WHERE contact_id=?").get(contactId);
  if (!c) {
    db.prepare("INSERT INTO conversations(contact_id,last_message_at,unread_count) VALUES(?,?,?)")
      .run(contactId, lastMessageAt, unread ? 1 : 0);
  } else {
    db.prepare("UPDATE conversations SET last_message_at=?, unread_count=unread_count+? WHERE id=?")
      .run(lastMessageAt, unread ? 1 : 0, c.id);
  }
  return db.prepare("SELECT * FROM conversations WHERE contact_id=?").get(contactId);
}

function saveMessage({ conversationId, waMessageId=null, direction, type="text", body="", mediaId=null, status="received", timestamp=now(), raw=null }) {
  const exists = waMessageId ? db.prepare("SELECT id FROM messages WHERE wa_message_id=?").get(waMessageId) : null;
  if (exists) return exists.id;
  const result = db.prepare(`
    INSERT INTO messages(conversation_id,wa_message_id,direction,type,body,media_id,status,timestamp,raw_json)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(conversationId, waMessageId, direction, type, body, mediaId, status, timestamp, raw ? JSON.stringify(raw) : null);
  return result.lastInsertRowid;
}

function isoFromWaTimestamp(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : now();
}

async function graphSend(payload) {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.PHONE_NUMBER_ID)
    throw new Error("WHATSAPP_ACCESS_TOKEN and PHONE_NUMBER_ID are not configured");
  const url = `https://graph.facebook.com/${env.GRAPH_VERSION || "v23.0"}/${env.PHONE_NUMBER_ID}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error?.message || "Meta API request failed");
    err.status = r.status; err.meta = data;
    throw err;
  }
  return data;
}

/* Webhook verification */
app.get("/webhook", (req,res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === env.META_VERIFY_TOKEN)
    return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* Webhook receiver: stores inbound messages and delivery/read statuses. */
app.post("/webhook", (req,res) => {
  try {
    const body = req.body;
    if (body?.object !== "whatsapp_business_account") return res.sendStatus(200);
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contacts = value.contacts || [];
        const profileNames = new Map(contacts.map(c => [c.wa_id, c.profile?.name]));
        for (const m of value.messages || []) {
          const waId = m.from;
          const contact = upsertContact(waId, profileNames.get(waId) || null);
          const stamp = isoFromWaTimestamp(m.timestamp);
          const conv = upsertConversation(contact.id, stamp, true);
          let type = m.type || "unknown", text = "", mediaId = null;
          if (type === "text") text = m.text?.body || "";
          else if (m[type]?.id) { mediaId = m[type].id; text = m[type]?.caption || `[${type}]`; }
          else if (m[type]?.body) text = m[type].body;
          saveMessage({
            conversationId: conv.id, waMessageId: m.id, direction: "in",
            type, body: text, mediaId, status: "received", timestamp: stamp, raw: m
          });
        }
        for (const s of value.statuses || []) {
          const status = s.status;
          if (s.id) db.prepare("UPDATE messages SET status=? WHERE wa_message_id=?").run(status, s.id);
        }
      }
    }
    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error", e);
    return res.sendStatus(200);
  }
});

/* API */
app.get("/api/me", dashboardAuth, (req,res)=>res.json({
  ok:true, configured:Boolean(env.WHATSAPP_ACCESS_TOKEN && env.PHONE_NUMBER_ID),
  phoneNumberId: env.PHONE_NUMBER_ID || null
}));

app.get("/api/conversations", dashboardAuth, (req,res)=>{
  const rows = db.prepare(`
    SELECT c.id conversation_id, c.last_message_at, c.unread_count, c.status,
           p.id contact_id, p.wa_id, p.name, p.phone,
           (SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) preview
    FROM conversations c JOIN contacts p ON p.id=c.contact_id
    ORDER BY COALESCE(c.last_message_at,'') DESC, c.id DESC
  `).all();
  res.json(rows);
});

app.get("/api/conversations/:id/messages", dashboardAuth, (req,res)=>{
  const rows = db.prepare(`
    SELECT id,wa_message_id,direction,type,body,media_id,status,timestamp
    FROM messages WHERE conversation_id=? ORDER BY id ASC
  `).all(req.params.id);
  db.prepare("UPDATE conversations SET unread_count=0 WHERE id=?").run(req.params.id);
  res.json(rows);
});

app.post("/api/send/text", dashboardAuth, async (req,res)=>{
  try {
    const { conversationId, text } = req.body;
    if (!conversationId || !text?.trim()) return res.status(400).json({error:"conversationId and text are required"});
    const conv = db.prepare(`
      SELECT c.*, p.wa_id FROM conversations c JOIN contacts p ON p.id=c.contact_id WHERE c.id=?
    `).get(conversationId);
    if (!conv) return res.status(404).json({error:"Conversation not found"});

    const data = await graphSend({
      to: conv.wa_id, type:"text", text:{ preview_url:false, body:text.trim() }
    });
    const messageId = data?.messages?.[0]?.id || null;
    saveMessage({
      conversationId, waMessageId:messageId, direction:"out", type:"text",
      body:text.trim(), status:"sent", timestamp:now(), raw:data
    });
    db.prepare("UPDATE conversations SET last_message_at=? WHERE id=?").run(now(), conversationId);
    res.json({ok:true,data});
  } catch(e) {
    console.error(e);
    res.status(e.status || 500).json({error:e.message, meta:e.meta || null});
  }
});

app.post("/api/send/template", dashboardAuth, async (req,res)=>{
  try {
    const { conversationId, name, languageCode="en_US", components=[] } = req.body;
    if (!conversationId || !name) return res.status(400).json({error:"conversationId and template name are required"});
    const conv = db.prepare(`
      SELECT c.*, p.wa_id FROM conversations c JOIN contacts p ON p.id=c.contact_id WHERE c.id=?
    `).get(conversationId);
    if (!conv) return res.status(404).json({error:"Conversation not found"});
    const data = await graphSend({
      to:conv.wa_id, type:"template",
      template:{name,language:{code:languageCode},components}
    });
    saveMessage({
      conversationId, waMessageId:data?.messages?.[0]?.id || null, direction:"out",
      type:"template", body:`Template: ${name}`, status:"sent", timestamp:now(), raw:data
    });
    db.prepare("UPDATE conversations SET last_message_at=? WHERE id=?").run(now(), conversationId);
    res.json({ok:true,data});
  } catch(e) { res.status(e.status || 500).json({error:e.message,meta:e.meta||null}); }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

const port = Number(env.PORT || 3000);
app.listen(port, ()=>console.log(`RakibFlow Inbox: http://localhost:${port}`));
