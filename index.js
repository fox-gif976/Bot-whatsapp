// index.js
// WhatsApp Bot (Baileys) + Pairing Code + Ping HTTP + Economia + AFK
// Requisitos: npm i @whiskeysockets/baileys pino express

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs");
const path = require("path");
const express = require("express");

// =======================
// CONFIG
// =======================

// Coloque seu número aqui (somente números). Pode ser com 55 ou sem.
// Ex: "554792186704" (com 55) OU "4792186704" (sem 55)
const OWNER_NUMBER = process.env.OWNER_NUMBER || "554792186704";

// Número para pairing code (somente números). Ex: 554792186704
const PAIRING_NUMBER = process.env.PAIRING_NUMBER || "";

// Cooldowns (em ms)
const WORK_COOLDOWN = 15 * 60 * 1000;  // 15 min
const MINE_COOLDOWN = 20 * 60 * 1000;  // 20 min
const PRAY_COOLDOWN = 10 * 60 * 1000;  // 10 min

// Ping / Keep Alive
const PORT = process.env.PORT || 3000;
// Se quiser auto-pingar, defina SELF_PING_URL (ex: https://seuapp.up.railway.app/ping)
const SELF_PING_URL = process.env.SELF_PING_URL || "";
const SELF_PING_INTERVAL = 5 * 60 * 1000; // 5 min

// DB
const DB_FILE = path.join(__dirname, "database.json");

// =======================
// HELPERS
// =======================
function onlyNumber(str = "") {
  return String(str).replace(/\D/g, "");
}

function normalizeOwnerNumber(n) {
  const nn = onlyNumber(n);
  // se já começa com 55, beleza; se não, não invento DDI — você decide.
  return nn;
}

const OWNER_NORM = normalizeOwnerNumber(OWNER_NUMBER);

function ensureDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify({ users: {} }, null, 2),
      "utf-8"
    );
  }
}

function loadDB() {
  ensureDB();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
}

function getUser(db, jid) {
  if (!db.users[jid]) {
    db.users[jid] = {
      moedas: 0,
      afk: { on: false, reason: "", since: 0 },
      cooldowns: { work: 0, mine: 0, pray: 0 }
    };
  }
  return db.users[jid];
}

function getText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ""
  );
}

function getMentionedJids(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

function getRepliedJid(msg) {
  // Se a pessoa respondeu uma mensagem, tenta pegar o participante
  return msg.message?.extendedTextMessage?.contextInfo?.participant || "";
}

function parseNumber(s) {
  const n = Number(String(s || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function now() {
  return Date.now();
}

function msToMinSec(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}s`;
  return `${m}m ${r}s`;
}

// Evita spam de aviso AFK: 1 aviso por mensagem por usuário mencionado
const afkNoticeCache = new Set(); // key: `${msgId}:${mentionedJid}`

// =======================
// HTTP PING (Railway)
// =======================
const app = express();

app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/ping", (req, res) =>
  res.status(200).json({ ok: true, ts: Date.now() })
);
app.get("/status", (req, res) =>
  res.status(200).json({ ok: true, uptime: process.uptime() })
);

app.listen(PORT, () => {
  console.log(`[HTTP] Online na porta ${PORT}`);
});

async function startSelfPing() {
  if (!SELF_PING_URL) return;
  console.log("[PING] Auto-ping ligado:", SELF_PING_URL);

  setInterval(async () => {
    try {
      const r = await fetch(SELF_PING_URL);
      console.log("[PING] ok", r.status);
    } catch (e) {
      console.log("[PING] falhou:", e?.message || e);
    }
  }, SELF_PING_INTERVAL);
}

// =======================
// BOT
// =======================
async function startBot() {
  ensureDB();

  const { state, saveCreds } = await useMultiFileAuthState("auth");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false // QR no terminal é ruim no Railway
  });

  sock.ev.on("creds.update", saveCreds);

  // Se não estiver logado ainda, tenta Pairing Code
  // Obs: vai aparecer no LOG do Railway o código
  if (PAIRING_NUMBER) {
    try {
      // se ainda não tem creds registrados
      if (!state.creds?.registered) {
        const number = onlyNumber(PAIRING_NUMBER);
        const code = await sock.requestPairingCode(number);
        console.log(`✅ Pairing Code (WhatsApp -> Aparelhos conectados -> Conectar com número): ${code}`);
      }
    } catch (e) {
      console.log("⚠️ Não consegui gerar pairing code:", e?.message || e);
      console.log("Se já estiver conectado, ignora.");
    }
  } else {
    console.log("⚠️ PAIRING_NUMBER não definido. Defina a variável PAIRING_NUMBER no Railway pra logar por código.");
  }

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log("❌ Conexão fechada. code=", code, "reconectar?", shouldReconnect);
      if (shouldReconnect) startBot();
    }

    if (connection === "open") {
      console.log("✅ Bot conectado com sucesso!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg?.message) return;
    if (msg.key?.remoteJid === "status@broadcast") return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");
    const sender = isGroup ? (msg.key.participant || "") : from;

    const senderNum = onlyNumber(sender); // ex: 5547...
    const isOwner = senderNum === OWNER_NORM;

    const textRaw = getText(msg).trim();
    if (!textRaw) return;

    const db = loadDB();
    const me = getUser(db, sender);

    // =======================
    // AFK: se o próprio afk falar algo, tira do afk
    // =======================
    if (me.afk?.on) {
      me.afk.on = false;
      me.afk.reason = "";
      me.afk.since = 0;
      saveDB(db);
      await sock.sendMessage(from, { text: "✅ você não está mais afk." }, { quoted: msg });
    }

    // =======================
    // AFK: se mencionar alguém afk, avisa 1x por mensagem
    // =======================
    const mentions = getMentionedJids(msg);
    if (mentions.length) {
      for (const mjid of mentions) {
        const mu = getUser(db, mjid);
        if (mu.afk?.on) {
          const key = `${msg.key.id}:${mjid}`;
          if (afkNoticeCache.has(key)) continue;
          afkNoticeCache.add(key);

          const reason = mu.afk.reason ? mu.afk.reason : "sem motivo";
          await sock.sendMessage(from, {
            text: `⚠️ @${onlyNumber(mjid)} está afk.\nMotivo: ${reason}`,
            mentions: [mjid]
          }, { quoted: msg });
        }
      }
      saveDB(db);
    }

    // =======================
    // Comandos
    // =======================
    if (!textRaw.startsWith(".")) return;

    const args = textRaw.split(/\s+/);
    const cmd = args[0].toLowerCase();

    // .ping
    if (cmd === ".ping") {
      const msStart = Date.now();
      const uptime = Math.floor(process.uptime());
      await sock.sendMessage(from, {
        text: `🏓 pong!\nUptime: ${uptime}s\nDelay: ${Date.now() - msStart}ms`
      }, { quoted: msg });
      return;
    }

    // .afk motivo...
    if (cmd === ".afk") {
      const reason = args.slice(1).join(" ").trim();
      me.afk.on = true;
      me.afk.reason = reason || "sem motivo";
      me.afk.since = now();
      saveDB(db);

      await sock.sendMessage(from, {
        text: `✅ você está afk.\nMotivo: ${me.afk.reason}`
      }, { quoted: msg });
      return;
    }

    // =======================
    // ECONOMIA: trabalhar / minerar / orar
    // =======================
    if (cmd === ".trabalhar") {
      const left = (me.cooldowns.work + WORK_COOLDOWN) - now();
      if (left > 0) {
        return sock.sendMessage(from, { text: `⏳ espere ${msToMinSec(left)} para trabalhar de novo.` }, { quoted: msg });
      }
      const ganho = Math.floor(Math.random() * (100 - 50 + 1)) + 50;
      me.moedas += ganho;
      me.cooldowns.work = now();
      saveDB(db);

      return sock.sendMessage(from, { text: `💼 Você trabalhou e ganhou ${ganho} moedas! 💰\nSaldo: ${me.moedas}` }, { quoted: msg });
    }

    if (cmd === ".minerar") {
      const left = (me.cooldowns.mine + MINE_COOLDOWN) - now();
      if (left > 0) {
        return sock.sendMessage(from, { text: `⏳ espere ${msToMinSec(left)} para minerar de novo.` }, { quoted: msg });
      }
      const ganho = Math.floor(Math.random() * (200 - 100 + 1)) + 100;
      me.moedas += ganho;
      me.cooldowns.mine = now();
      saveDB(db);

      return sock.sendMessage(from, { text: `⛏️ Você minerou e ganhou ${ganho} moedas! 💰\nSaldo: ${me.moedas}` }, { quoted: msg });
    }

    if (cmd === ".orar") {
      const left = (me.cooldowns.pray + PRAY_COOLDOWN) - now();
      if (left > 0) {
        return sock.sendMessage(from, { text: `⏳ espere ${msToMinSec(left)} para orar de novo.` }, { quoted: msg });
      }
      const ganho = 25;
      me.moedas += ganho;
      me.cooldowns.pray = now();
      saveDB(db);

      return sock.sendMessage(from, { text: `🙏 Você orou e ganhou ${ganho} moedas.\nSaldo: ${me.moedas}` }, { quoted: msg });
    }

    // =======================
    // DONO: addmoney / removemoney
    // Aceita:
    // .addmoney @pessoa 100
    // .removemoney @pessoa 100
    // .add money @pessoa 100
    // .remove money @pessoa 100
    // Também funciona respondendo uma mensagem (reply) em vez de @
    // =======================
    const isAddMoney = (cmd === ".addmoney") || (cmd === ".add" && args[1]?.toLowerCase() === "money");
    const isRemoveMoney = (cmd === ".removemoney") || (cmd === ".remove" && args[1]?.toLowerCase() === "money");

    if (isAddMoney || isRemoveMoney) {
      if (!isOwner) {
        return sock.sendMessage(from, { text: "❌ Só o dono pode usar esse comando." }, { quoted: msg });
      }

      const mentionList = getMentionedJids(msg);
      const replied = getRepliedJid(msg);
      const alvo = mentionList[0] || replied;

      const valueArg = isAddMoney || isRemoveMoney
        ? args.find(a => /^\d+$/.test(a))
        : "";

      const valor = parseNumber(valueArg);

      if (!alvo || !Number.isFinite(valor) || valor <= 0) {
        return sock.sendMessage(from, {
          text: "✅ Uso:\n.addmoney @pessoa 100\n.removemoney @pessoa 100\n(ou responda a mensagem da pessoa)"
        }, { quoted: msg });
      }

      const alvoUser = getUser(db, alvo);

      if (isAddMoney) {
        alvoUser.moedas += valor;
        saveDB(db);
        return sock.sendMessage(from, {
          text: `✅ Adicionei ${valor} moedas para @${onlyNumber(alvo)}.\nSaldo dela: ${alvoUser.moedas}`,
          mentions: [alvo]
        }, { quoted: msg });
      } else {
        alvoUser.moedas = Math.max(0, alvoUser.moedas - valor);
        saveDB(db);
        return sock.sendMessage(from, {
          text: `✅ Removi ${valor} moedas de @${onlyNumber(alvo)}.\nSaldo dela: ${alvoUser.moedas}`,
          mentions: [alvo]
        }, { quoted: msg });
      }
    }
  });

  await startSelfPing();
}

startBot().catch((e) => console.error("FATAL:", e));