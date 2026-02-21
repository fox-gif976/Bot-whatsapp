const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys")

const pino = require("pino")
const fs = require("fs")
const qrcode = require("qrcode-terminal")

// ✅ DONO (só números)
const OWNER_NUMBER = "554792186704" // 47 99218-6704 com 55 na frente

const DB_FILE = "database.json"

// ====== COOLDOWNS / LIMITES ======
const GENIO_COOLDOWN = 15 * 60 * 1000 // 15 min
const JACKPOT_COST = 500
const JACKPOT_CHANCE = 10 // %
const JACKPOT_PRIZE = 10000

// Anti-duplicação (resolve o “manda várias vezes”)
const processedMessages = new Set()

// ====== DB ======
function ensureDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify(
        {
          users: {},
          shop: { espada: 100, arco: 150, vip: 1000 }
        },
        null,
        2
      )
    )
  }
}

function getDB() {
  ensureDB()
  return JSON.parse(fs.readFileSync(DB_FILE))
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2))
}

function todayKey() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function getUser(db, jid) {
  if (!db.users[jid]) {
    db.users[jid] = {
      moedas: 0,
      afk: false,
      afkMotivo: "",
      cooldowns: {
        genio: 0
      },
      daily: {
        key: todayKey(),
        missao: false
      }
    }
  } else {
    db.users[jid].moedas ??= 0
    db.users[jid].afk ??= false
    db.users[jid].afkMotivo ??= ""
    db.users[jid].cooldowns ??= { genio: 0 }
    db.users[jid].cooldowns.genio ??= 0
    db.users[jid].daily ??= { key: todayKey(), missao: false }
    db.users[jid].daily.key ??= todayKey()
    db.users[jid].daily.missao ??= false
  }

  // reset diário
  const tk = todayKey()
  if (db.users[jid].daily.key !== tk) {
    db.users[jid].daily = { key: tk, missao: false }
  }

  return db.users[jid]
}

// ====== HELPERS ======
function onlyNumber(jid) {
  return (jid || "").split("@")[0].split(":")[0]
}

function isOwner(senderJid) {
  return onlyNumber(senderJid) === OWNER_NUMBER
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function parseNumber(str) {
  const n = Number(str)
  return Number.isFinite(n) ? Math.floor(n) : NaN
}

function getMentionedJid(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || null
}

function getMentionedList(msg) {
  return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
}

function msToMinSec(ms) {
  const s = Math.ceil(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return m <= 0 ? `${r}s` : `${m}m ${r}s`
}

function getText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ""
  )
}

async function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms))
}

// ====== BOT ======
async function startBot() {
  ensureDB()

  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" })
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update

    if (qr) {
      console.log("\n📱 Escaneie o QR (WhatsApp > Aparelhos conectados):\n")
      qrcode.generate(qr, { small: true })
    }

    if (connection === "open") console.log("✅ Bot conectado com sucesso!")

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      console.log(`⚠️ Conexão fechada. statusCode=${statusCode ?? "?"}`)

      if (statusCode === DisconnectReason.loggedOut) {
        console.log("🚪 Deslogado. Apague a pasta 'auth' e conecte de novo.")
        return
      }

      console.log("🔁 Tentando reconectar...")
      setTimeout(() => startBot(), 2000)
    }
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages?.[0]
    if (!msg?.message) return

    // ✅ Anti-duplicação por ID (mata o spam de AFK/commands repetidos)
    const mid = msg.key?.id
    if (!mid) return
    if (processedMessages.has(mid)) return
    processedMessages.add(mid)
    setTimeout(() => processedMessages.delete(mid), 60_000)

    const from = msg.key.remoteJid
    const sender = msg.key.participant || from
    const text = getText(msg).trim()

    const db = getDB()
    const me = getUser(db, sender)

    // ✅ AFK: avisar quando alguém marca (uma vez por mensagem, sem repetir)
    const mentioned = getMentionedList(msg)
    if (mentioned.length > 0) {
      for (const mjid of mentioned) {
        const u = getUser(db, mjid)
        if (u.afk) {
          await sock.sendMessage(from, {
            text: `@${onlyNumber(mjid)} está afk\nmotivo: ${u.afkMotivo || "sem motivo"}`,
            mentions: [mjid]
          })
        }
      }
      saveDB(db)
    }

    // ✅ Sai do AFK quando falar (mas não quando o comando for .afk)
    const isAfkCmd = text.toLowerCase().startsWith(".afk")
    if (me.afk && !isAfkCmd) {
      me.afk = false
      me.afkMotivo = ""
      saveDB(db)
      await sock.sendMessage(from, { text: "✅ você não está mais afk" })
    }

    if (!text.startsWith(".")) return

    const args = text.split(/\s+/)
    const cmd = (args[0] || "").toLowerCase()
    const sub1 = (args[1] || "").toLowerCase()

    // ===== BÁSICOS =====
    if (cmd === ".meuid") {
      return sock.sendMessage(from, { text: `Seu JID é:\n${sender}` })
    }

    if (cmd === ".carteira") {
      return sock.sendMessage(from, { text: `💰 Você tem ${me.moedas} moedas.` })
    }

    if (cmd === ".kit") {
      me.moedas += 50
      saveDB(db)
      return sock.sendMessage(from, { text: "🎁 Você recebeu 50 moedas!" })
    }

    // ===== AFK =====
    if (cmd === ".afk") {
      const motivo = args.slice(1).join(" ").trim()
      me.afk = true
      me.afkMotivo = motivo || "sem motivo"
      saveDB(db)
      return sock.sendMessage(from, { text: `você está afk\nmotivo: ${me.afkMotivo}` })
    }

    // ===== MISSÃO DIÁRIA =====
    if (cmd === ".missao") {
      if (me.daily.missao) {
        return sock.sendMessage(from, { text: "📅 Você já fez a missão de hoje. Volta amanhã 😼" })
      }
      const ganho = randInt(100, 500)
      me.moedas += ganho
      me.daily.missao = true
      saveDB(db)
      return sock.sendMessage(from, { text: `📅 Missão diária completa! Você ganhou ${ganho} moedas.` })
    }

    // ===== GÊNIO =====
    if (cmd === ".genio") {
      const now = Date.now()
      const falta = me.cooldowns.genio + GENIO_COOLDOWN - now
      if (falta > 0) {
        return sock.sendMessage(from, { text: `⏳ Aguarde ${msToMinSec(falta)} para usar o gênio de novo.` })
      }

      me.cooldowns.genio = now

      // sorteio 1–100 (interno)
      const n = randInt(1, 100)

      // 🎯 Regras:
      // 1% mítico -> 20000
      // 4% super -> 5000–10000
      // 25% médio -> 500–1500
      // 40% pequeno -> 50–300
      // 30% perde
      let ganho = 0

      if (n === 1) {
        ganho = 20000 // 🔴 mítico 1%
      } else if (n <= 5) {
        ganho = randInt(5000, 10000) // 4%
      } else if (n <= 30) {
        ganho = randInt(500, 1500) // 25%
      } else if (n <= 70) {
        ganho = randInt(50, 300) // 40%
      } else {
        ganho = 0 // 30%
      }

      if (ganho <= 0) {
        saveDB(db)
        return sock.sendMessage(from, { text: "não foi dessa vez, boa sorte na próxima❤️" })
      }

      me.moedas += ganho
      saveDB(db)

      if (ganho >= 20000) {
        return sock.sendMessage(from, { text: `🔴 MÍTICO!!! 🧞‍♂️\nVocê ganhou ${ganho} moedas!` })
      }
      return sock.sendMessage(from, { text: `🧞‍♂️ O gênio te abençoou! Você ganhou ${ganho} moedas!` })
    }

    // ===== JACKPOT =====
    if (cmd === ".jackpot") {
      if (me.moedas < JACKPOT_COST) {
        return sock.sendMessage(from, { text: `❌ Você precisa de ${JACKPOT_COST} moedas para jogar.` })
      }

      me.moedas -= JACKPOT_COST
      saveDB(db)

      // animação
      await sock.sendMessage(from, { text: "🎰 Girando..." })
      await sleep(900)
      await sock.sendMessage(from, { text: "💫 Quase..." })
      await sleep(900)
      await sock.sendMessage(from, { text: "✨ Resultado:" })
      await sleep(800)

      const roll = randInt(1, 100)
      if (roll <= JACKPOT_CHANCE) {
        me.moedas += JACKPOT_PRIZE
        saveDB(db)
        return sock.sendMessage(from, { text: `🎉 JACKPOT!!!\nVocê ganhou ${JACKPOT_PRIZE} moedas!` })
      }

      saveDB(db)
      return sock.sendMessage(from, { text: "não foi dessa vez, boa sorte na próxima❤️" })
    }

    // ===== APOSTAR =====
    if (cmd === ".apostar") {
      const valor = parseNumber(args[1])
      if (!Number.isFinite(valor) || valor <= 0) {
        return sock.sendMessage(from, { text: "✅ Use: .apostar 100" })
      }
      if (me.moedas < valor) {
        return sock.sendMessage(from, { text: `❌ Você não tem moedas suficientes. Faltam ${valor - me.moedas}.` })
      }

      // 50/50
      const win = randInt(1, 100) <= 50
      if (win) {
        me.moedas += valor // lucro = valor (recebe +valor além do que tinha)
        saveDB(db)
        return sock.sendMessage(from, { text: `🎲 Você ganhou!\nRecebeu ${valor * 2} moedas no total (lucro +${valor}).` })
      } else {
        me.moedas -= valor
        saveDB(db)
        return sock.sendMessage(from, { text: "💀 Não foi dessa vez...\nBoa sorte na próxima ❤️" })
      }
    }

    // ===== SHOP / BUY =====
    if (cmd === ".shop") {
      let lista = "🛒 Loja:\n\n"
      for (const item in db.shop) lista += `${item} - ${db.shop[item]} moedas\n`
      lista += `\nUse: .buy <item>\nEx: .buy espada`
      return sock.sendMessage(from, { text: lista })
    }

    if (cmd === ".buy") {
      const item = (args[1] || "").toLowerCase()
      if (!item || !db.shop[item]) return sock.sendMessage(from, { text: "❌ Item não encontrado. Use .shop" })

      const preco = db.shop[item]
      if (me.moedas < preco) return sock.sendMessage(from, { text: `❌ Moedas insuficientes. Faltam ${preco - me.moedas}.` })

      me.moedas -= preco
      saveDB(db)
      return sock.sendMessage(from, { text: `✅ Você comprou ${item} por ${preco} moedas!` })
    }

    // ===== RANKING =====
    if (cmd === ".ranking") {
      const ranking = Object.entries(db.users)
        .sort((a, b) => (b[1]?.moedas || 0) - (a[1]?.moedas || 0))
        .slice(0, 10)

      let lista = "🏆 Ranking (Top 10):\n\n"
      ranking.forEach(([id, data], i) => (lista += `${i + 1}° - ${data.moedas} moedas\n`))
      return sock.sendMessage(from, { text: lista })
    }

    // ===== ABRAÇAR / BEIJAR =====
    if (cmd === ".abraçar") {
      const alvo = getMentionedJid(msg)
      if (!alvo) return sock.sendMessage(from, { text: "✅ Use: .abraçar @pessoa" })

      const frases = [
        `🤗 @${onlyNumber(sender)} abraçou @${onlyNumber(alvo)} bem forte!`,
        `🫂 @${onlyNumber(sender)} deu um abraço quentinho em @${onlyNumber(alvo)}!`,
        `💞 Abraço de respeito: @${onlyNumber(sender)} → @${onlyNumber(alvo)}!`
      ]
      return sock.sendMessage(from, { text: frases[randInt(0, frases.length - 1)], mentions: [sender, alvo] })
    }

    if (cmd === ".beijar") {
      const alvo = getMentionedJid(msg)
      if (!alvo) return sock.sendMessage(from, { text: "✅ Use: .beijar @pessoa" })

      const frases = [
        `💋 @${onlyNumber(sender)} beijou @${onlyNumber(alvo)}!`,
        `😚 @${onlyNumber(sender)} deu um beijinho em @${onlyNumber(alvo)}!`,
        `😘 @${onlyNumber(sender)} mandou um beijo pra @${onlyNumber(alvo)}!`
      ]
      return sock.sendMessage(from, { text: frases[randInt(0, frases.length - 1)], mentions: [sender, alvo] })
    }

    // ===== ADD / REMOVE MONEY (SÓ DONO) =====
    const isAddMoney = cmd === ".addmoney" || (cmd === ".add" && sub1 === "money")
    const isRemoveMoney = cmd === ".removemoney" || (cmd === ".remove" && sub1 === "money")

    if (isAddMoney || isRemoveMoney) {
      if (!isOwner(sender)) {
        return sock.sendMessage(from, { text: "❌ Só o dono pode usar esse comando." })
      }

      const alvo = getMentionedJid(msg)
      const valor = parseNumber(args[3])

      if (!alvo || !Number.isFinite(valor) || valor <= 0) {
        return sock.sendMessage(from, { text: "✅ Uso:\n.add money @pessoa 100\n.remove money @pessoa 100" })
      }

      const alvoUser = getUser(db, alvo)

      if (isAddMoney) {
        alvoUser.moedas += valor
        saveDB(db)
        return sock.sendMessage(from, {
          text: `✅ Adicionei ${valor} moedas para @${onlyNumber(alvo)}`,
          mentions: [alvo]
        })
      } else {
        alvoUser.moedas = Math.max(0, alvoUser.moedas - valor)
        saveDB(db)
        return sock.sendMessage(from, {
          text: `✅ Removi ${valor} moedas de @${onlyNumber(alvo)}`,
          mentions: [alvo]
        })
      }
    }

    // fallback (opcional)
    // return sock.sendMessage(from, { text: "❓ Comando não reconhecido." })
  })
}

startBot()
