import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const app = express();
app.use(express.json({ limit: "10mb" }));

const now = () => new Date().toISOString();

function dashboardAuth(req, res, next) {
  const password = env.DASHBOARD_PASSWORD;
  if (!password) return next();
  const supplied = req.get("x-dashboard-password") || req.query.password;
  if (supplied === password) return next();
  return res.status(401).json({ error: "Dashboard authentication required" });
}

// Shared-secret auth for calls coming *from* n8n (so n8n never needs the
// dashboard password or the raw Meta access token). Only needed if n8n
// chooses to call back into this app instead of talking to Supabase/Meta directly.
function n8nAuth(req, res, next) {
  const secret = env.N8N_SHARED_SECRET;
  if (!secret) return res.status(500).json({ error: "N8N_SHARED_SECRET is not configured on the server" });
  const supplied = req.get("x-n8n-secret");
  if (supplied === secret) return next();
  return res.status(401).json({ error: "Invalid or missing x-n8n-secret header" });
}

async function upsertContact(waId, name = null) {
  const t = now();
  const { data: existing } = await supabase.from("contacts").select("*").eq("wa_id", waId).maybeSingle();
  if (existing) {
    const { data } = await supabase.from("contacts")
      .update({ name: name ?? existing.name, phone: waId, updated_at: t })
      .eq("id", existing.id).select().single();
    return data;
  }
  const { data } = await supabase.from("contacts")
    .insert({ wa_id: waId, name, phone: waId, created_at: t, updated_at: t })
    .select().single();
  return data;
}

async function upsertConversation(contactId, lastMessageAt, unread = false) {
  const { data: existing } = await supabase.from("conversations").select("*").eq("contact_id", contactId).maybeSingle();
  if (!existing) {
    const { data } = await supabase.from("conversations")
      .insert({ contact_id: contactId, last_message_at: lastMessageAt, unread_count: unread ? 1 : 0 })
      .select().single();
    return data;
  }
  const { data } = await supabase.from("conversations")
    .update({ last_message_at: lastMessageAt, unread_count: existing.unread_count + (unread ? 1 : 0) })
    .eq("id", existing.id).select().single();
  return data;
}

async function saveMessage({ conversationId, waMessageId = null, direction, type = "text", body = "", mediaId = null, status = "received", timestamp = now(), raw = null }) {
  if (waMessageId) {
    const { data: existing } = await supabase.from("messages").select("id").eq("wa_message_id", waMessageId).maybeSingle();
    if (existing) return existing.id;
  }
  const { data } = await supabase.from("messages").insert({
    conversation_id: conversationId, wa_message_id: waMessageId, direction, type,
    body, media_id: mediaId, status, timestamp, raw_json: raw
  }).select("id").single();
  return data?.id;
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
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === env.META_VERIFY_TOKEN)
    return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* Webhook receiver: stores inbound messages and delivery/read statuses. */
app.post("/webhook", async (req, res) => {
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
          const contact = await upsertContact(waId, profileNames.get(waId) || null);
          const stamp = isoFromWaTimestamp(m.timestamp);
          const conv = await upsertConversation(contact.id, stamp, true);
          let type = m.type || "unknown", text = "", mediaId = null;
          if (type === "text") text = m.text?.body || "";
          else if (m[type]?.id) { mediaId = m[type].id; text = m[type]?.caption || `[${type}]`; }
          else if (m[type]?.body) text = m[type].body;
          await saveMessage({
            conversationId: conv.id, waMessageId: m.id, direction: "in",
            type, body: text, mediaId, status: "received", timestamp: stamp, raw: m
          });

          // NOTE: n8n now owns the bot flow end-to-end and receives inbound
          // messages directly from Meta's webhook (see DEPLOYMENT.md), so this
          // endpoint no longer forwards to n8n. It's kept only as a legacy
          // fallback / manual-inbox recorder; saveMessage() is idempotent on
          // wa_message_id, so it's safe even if both Meta destinations are
          // still configured during migration.
        }
        for (const s of value.statuses || []) {
          const status = s.status;
          if (s.id) await supabase.from("messages").update({ status }).eq("wa_message_id", s.id);
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
app.get("/api/me", dashboardAuth, (req, res) => res.json({
  ok: true, configured: Boolean(env.WHATSAPP_ACCESS_TOKEN && env.PHONE_NUMBER_ID),
  phoneNumberId: env.PHONE_NUMBER_ID || null
}));

app.get("/api/conversations", dashboardAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("conversation_list")
    .select("*")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("conversation_id", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/conversations/:id/messages", dashboardAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("messages")
    .select("id,wa_message_id,direction,type,body,media_id,status,timestamp")
    .eq("conversation_id", req.params.id)
    .order("id", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  await supabase.from("conversations").update({ unread_count: 0 }).eq("id", req.params.id);
  res.json(data);
});

// Toggle bot control for a conversation. When bot_enabled is turned off,
// the human agent has taken over and n8n should stop auto-replying here.
app.post("/api/conversations/:id/bot", dashboardAuth, async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) is required" });
  const { data, error } = await supabase
    .from("conversations")
    .update({ bot_enabled: enabled })
    .eq("id", req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Conversation not found" });
  res.json({ ok: true, conversation: data });
});

app.post("/api/send/text", dashboardAuth, async (req, res) => {
  try {
    const { conversationId, text } = req.body;
    if (!conversationId || !text?.trim()) return res.status(400).json({ error: "conversationId and text are required" });
    const { data: conv } = await supabase
      .from("conversations")
      .select("*, contacts!inner(wa_id)")
      .eq("id", conversationId).maybeSingle();
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    const data = await graphSend({
      to: conv.contacts.wa_id, type: "text", text: { preview_url: false, body: text.trim() }
    });
    const messageId = data?.messages?.[0]?.id || null;
    await saveMessage({
      conversationId, waMessageId: messageId, direction: "out", type: "text",
      body: text.trim(), status: "sent", timestamp: now(), raw: data
    });
    // A human agent just replied by hand: turn the bot off for this
    // conversation so n8n stops auto-replying and doesn't collide with the agent.
    await supabase.from("conversations").update({ last_message_at: now(), bot_enabled: false }).eq("id", conversationId);
    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message, meta: e.meta || null });
  }
});

app.post("/api/send/template", dashboardAuth, async (req, res) => {
  try {
    const { conversationId, name, languageCode = "en_US", components = [] } = req.body;
    if (!conversationId || !name) return res.status(400).json({ error: "conversationId and template name are required" });
    const { data: conv } = await supabase
      .from("conversations")
      .select("*, contacts!inner(wa_id)")
      .eq("id", conversationId).maybeSingle();
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    const data = await graphSend({
      to: conv.contacts.wa_id, type: "template",
      template: { name, language: { code: languageCode }, components }
    });
    await saveMessage({
      conversationId, waMessageId: data?.messages?.[0]?.id || null, direction: "out",
      type: "template", body: `Template: ${name}`, status: "sent", timestamp: now(), raw: data
    });
    await supabase.from("conversations").update({ last_message_at: now() }).eq("id", conversationId);
    res.json({ ok: true, data });
  } catch (e) { res.status(e.status || 500).json({ error: e.message, meta: e.meta || null }); }
});

// Optional convenience endpoint if n8n prefers routing sends through this
// backend (keeps WHATSAPP_ACCESS_TOKEN in one place) instead of calling the
// Meta Graph API directly with its own copy of the token.
app.post("/api/n8n/send", n8nAuth, async (req, res) => {
  try {
    const { conversationId, text } = req.body;
    if (!conversationId || !text?.trim()) return res.status(400).json({ error: "conversationId and text are required" });
    const { data: conv } = await supabase
      .from("conversations")
      .select("*, contacts!inner(wa_id)")
      .eq("id", conversationId).maybeSingle();
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (conv.bot_enabled === false) return res.status(409).json({ error: "Bot is disabled for this conversation (human agent has taken over)" });

    const data = await graphSend({
      to: conv.contacts.wa_id, type: "text", text: { preview_url: false, body: text.trim() }
    });
    const messageId = data?.messages?.[0]?.id || null;
    await saveMessage({
      conversationId, waMessageId: messageId, direction: "out", type: "text",
      body: text.trim(), status: "sent", timestamp: now(), raw: data
    });
    await supabase.from("conversations").update({ last_message_at: now() }).eq("id", conversationId);
    res.json({ ok: true, data });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message, meta: e.meta || null });
  }
});

// Optional convenience endpoint for n8n to flag a human handoff. n8n can also
// just update conversations.bot_enabled directly via a Supabase node instead.
app.post("/api/n8n/handoff", n8nAuth, async (req, res) => {
  const { conversationId } = req.body;
  if (!conversationId) return res.status(400).json({ error: "conversationId is required" });
  const { data, error } = await supabase
    .from("conversations")
    .update({ bot_enabled: false })
    .eq("id", conversationId)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Conversation not found" });
  res.json({ ok: true, conversation: data });
});

// Always serve the static dashboard + SPA fallback.
// On Vercel, vercel.json rewrites forward every request into this single
// function, so static files must be served here rather than relying on
// Vercel's separate static asset pipeline.
// Note: Express 5 (path-to-regexp v8) no longer accepts a bare "*" pattern,
// so the SPA fallback is a plain middleware with no path pattern.
app.use(express.static(path.join(__dirname, "..", "public")));
app.use((req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

if (!env.VERCEL) {
  const port = Number(env.PORT || 3000);
  app.listen(port, () => console.log(`RakibFlow Inbox: http://localhost:${port}`));
}

export default app;
