const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs-extra');
const cron = require('node-cron');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const session = require('express-session');
globalThis.crypto = crypto;

console.log('🚀 Iniciando Auto Envios Bot Multi-usuário...');

// Verificar dependências críticas
try {
  require('@whiskeysockets/baileys');
  console.log('✅ Baileys carregado');
} catch (error) {
  console.error('❌ Erro ao carregar Baileys:', error.message);
  console.log('📦 Execute: npm install @whiskeysockets/baileys@6.6.0');
  process.exit(1);
}

const WhatsAppBot = require('./bot/whatsapp-bot');

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Configurar sessões
const JWT_SECRET = process.env.JWT_SECRET || 'auto-envios-secret-key-2025';
app.use(session({
  secret: JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Instâncias dos bots por usuário
const userBots = new Map(); // userId -> WhatsAppBot instance
const activeTasks = new Map(); // userId -> Map(scheduleId -> cronJob)

// Configurações padrão
const defaultUserConfig = {
  youtubeApiKey: "",
  channelId: "",
  schedules: [],
  activeGroups: [],
  botConnected: false,
  antiBanSettings: {
    delayBetweenGroups: 5,
    delayBetweenMessages: 2,
    maxGroupsPerBatch: 10,
    batchDelay: 30
  }
};

// Função para log por usuário
function log(message, type = 'info', userId = null) {
  const timestamp = new Date().toISOString();
  const userPrefix = userId ? `[User:${userId}] ` : '';
  const logEntry = `[${timestamp}] ${userPrefix}${type.toUpperCase()}: ${message}`;
  console.log(logEntry);

  if (userId) {
    io.to(`user_${userId}`).emit('log', { message, type, timestamp });
  }
}

// Função helper para delay
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Gerenciamento de usuários
async function loadUsers() {
  try {
    await fs.ensureDir('./data');
    const usersPath = './data/users.json';
    if (await fs.pathExists(usersPath)) {
      const rawData = await fs.readFile(usersPath, 'utf8');
      if (!rawData || rawData.trim() === '') return {};
      return JSON.parse(rawData);
    }
    const emptyUsers = {};
    await fs.writeJSON(usersPath, emptyUsers, { spaces: 2 });
    return emptyUsers;
  } catch (error) {
    console.error('Erro ao carregar usuários:', error.message);
    return {};
  }
}

async function saveUsers(users) {
  try {
    await fs.ensureDir('./data');
    const usersPath = './data/users.json';
    await fs.writeJSON(usersPath, users, { spaces: 2 });
    return true;
  } catch (error) {
    console.error('Erro ao salvar usuários:', error.message);
    return false;
  }
}

// Funções de configuração por usuário
async function loadUserConfig(userId) {
  try {
    await fs.ensureDir(`./data/users/${userId}`);
    const configPath = `./data/users/${userId}/config.json`;
    if (await fs.pathExists(configPath)) {
      const rawData = await fs.readFile(configPath, 'utf8');
      if (!rawData || rawData.trim() === '') return { ...defaultUserConfig };
      return JSON.parse(rawData);
    }
    await fs.writeJSON(configPath, defaultUserConfig, { spaces: 2 });
    return { ...defaultUserConfig };
  } catch (error) {
    console.error('Erro ao carregar config do usuário:', error.message);
    return { ...defaultUserConfig };
  }
}

async function saveUserConfig(userId, config) {
  try {
    await fs.ensureDir(`./data/users/${userId}`);
    const configPath = `./data/users/${userId}/config.json`;
    await fs.writeJSON(configPath, config, { spaces: 2 });
    return true;
  } catch (error) {
    console.error('Erro ao salvar config do usuário:', error.message);
    return false;
  }
}

// Middleware de autenticação
function authenticateToken(req, res, next) {
  const token = req.session.token || req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token de acesso necessário' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
}

// Middleware de autenticação Socket.IO
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Token necessário'));
    const user = jwt.verify(token, JWT_SECRET);
    socket.userId = user.id;
    socket.username = user.username;
    socket.join(`user_${user.id}`);
    next();
  } catch {
    next(new Error('Token inválido'));
  }
});

// Função de envio com anti-ban
async function sendVideoWithAntiBot(userId, groupIds) {
  const userBot = userBots.get(userId);
  if (!userBot || !userBot.isConnected()) throw new Error('Bot não conectado');

  const config = await loadUserConfig(userId);
  const { antiBanSettings } = config;
  const totalGroups = groupIds.length;

  log(`Iniciando envio para ${totalGroups} grupos com proteção anti-banimento`, 'info', userId);

  const batches = [];
  for (let i = 0; i < groupIds.length; i += antiBanSettings.maxGroupsPerBatch) {
    batches.push(groupIds.slice(i, i + antiBanSettings.maxGroupsPerBatch));
  }

  log(`Dividido em ${batches.length} lotes de até ${antiBanSettings.maxGroupsPerBatch} grupos`, 'info', userId);

  let sentCount = 0;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    log(`Processando lote ${batchIndex + 1}/${batches.length}`, 'info', userId);

    for (let groupIndex = 0; groupIndex < batch.length; groupIndex++) {
      const groupId = batch[groupIndex];
      try {
        await userBot.sendLatestVideoToGroup(groupId, config);
        sentCount++;
        log(`✅ Enviado para grupo ${sentCount}/${totalGroups}`, 'success', userId);

        if (groupIndex < batch.length - 1) {
          log(`⏳ Aguardando ${antiBanSettings.delayBetweenGroups}s antes do próximo grupo...`, 'info', userId);
          await delay(antiBanSettings.delayBetweenGroups * 1000);
        }
      } catch (error) {
        log(`❌ Erro ao enviar para grupo: ${error.message}`, 'error', userId);
      }
    }

    if (batchIndex < batches.length - 1) {
      log(`⏳ Aguardando ${antiBanSettings.batchDelay}s antes do próximo lote...`, 'info', userId);
      await delay(antiBanSettings.batchDelay * 1000);
    }
  }

  log(`✅ Envio completo: ${sentCount}/${totalGroups} grupos`, 'success', userId);
  return sentCount;
}

// ==========================
// Inicializar WhatsApp Bot
// ==========================
async function initBot(userId) {
  if (userBots.has(userId)) return userBots.get(userId);

  const config = await loadUserConfig(userId);
  const bot = new WhatsAppBot(userId, config);

  bot.on('connected', async () => {
    log('Bot conectado ao WhatsApp', 'success', userId);
    config.botConnected = true;
    await saveUserConfig(userId, config);
  });

  bot.on('disconnected', async () => {
    log('Bot desconectado do WhatsApp', 'warn', userId);
    config.botConnected = false;
    await saveUserConfig(userId, config);
  });

  bot.on('error', (error) => {
    log(`Erro do bot: ${error.message}`, 'error', userId);
  });

  userBots.set(userId, bot);
  await bot.start();
  return bot;
}

// ==========================
// Rotas REST
// ==========================

// Login do usuário
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const users = await loadUsers();

  if (!users[username]) return res.status(401).json({ error: 'Usuário não encontrado' });
  const valid = await bcrypt.compare(password, users[username].passwordHash);
  if (!valid) return res.status(403).json({ error: 'Senha incorreta' });

  const token = jwt.sign({ id: username, username }, JWT_SECRET, { expiresIn: '24h' });
  req.session.token = token;

  res.json({ token, message: 'Login bem-sucedido' });
});

// Criar usuário
app.post('/api/users', async (req, res) => {
  const { username, password } = req.body;
  const users = await loadUsers();

  if (users[username]) return res.status(409).json({ error: 'Usuário já existe' });

  const passwordHash = await bcrypt.hash(password, 10);
  users[username] = { passwordHash, createdAt: new Date().toISOString() };
  await saveUsers(users);

  await loadUserConfig(username); // Criar config padrão

  res.json({ message: 'Usuário criado com sucesso' });
});

// Obter status do bot
app.get('/api/bot/status', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const bot = userBots.get(userId);
  res.json({ connected: bot?.isConnected() || false });
});

// Iniciar envio para grupos
app.post('/api/bot/send', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { groupIds } = req.body;

  if (!groupIds || !Array.isArray(groupIds)) return res.status(400).json({ error: 'groupIds inválido' });

  try {
    await initBot(userId);
    const sentCount = await sendVideoWithAntiBot(userId, groupIds);
    res.json({ message: `Envio completo para ${sentCount} grupos` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================
// Socket.IO events
// ==========================
io.on('connection', (socket) => {
  const userId = socket.userId;
  log('Cliente Socket conectado', 'info', userId);

  socket.on('send_video_groups', async (groupIds) => {
    try {
      const bot = await initBot(userId);
      const sentCount = await sendVideoWithAntiBot(userId, groupIds);
      socket.emit('send_complete', { sentCount });
    } catch (error) {
      socket.emit('send_error', { error: error.message });
    }
  });

  socket.on('disconnect', () => {
    log('Cliente Socket desconectado', 'warn', userId);
  });
});

// ==========================
// Cron jobs e tarefas automáticas
// ==========================
async function scheduleUserTasks(userId) {
  const config = await loadUserConfig(userId);
  if (!config.schedules || config.schedules.length === 0) return;

  const userActiveTasks = new Map();
  activeTasks.set(userId, userActiveTasks);

  for (const schedule of config.schedules) {
    const job = cron.schedule(schedule.cron, async () => {
      try {
        const bot = await initBot(userId);
        await sendVideoWithAntiBot(userId, schedule.groupIds);
      } catch (error) {
        log(`Erro no cron job: ${error.message}`, 'error', userId);
      }
    }, { timezone: schedule.timezone || 'America/Sao_Paulo' });

    userActiveTasks.set(schedule.id, job);
    log(`Agendamento ativo: ${schedule.id}`, 'info', userId);
  }
}

// ==========================
// Inicialização do servidor
// ==========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 Servidor rodando em http://localhost:${PORT}`);

  // Inicializa tarefas de todos os usuários existentes
  (async () => {
    try {
      const users = await loadUsers();
      for (const username of Object.keys(users)) {
        await scheduleUserTasks(username);
      }
    } catch (err) {
      console.error('Erro ao inicializar tarefas dos usuários:', err.message);
    }
  })();
});

// ==========================
// Shutdown limpo
// ==========================
async function shutdown() {
  console.log('🛑 Encerrando aplicação...');
  for (const [userId, bot] of userBots.entries()) {
    try { await bot.disconnect(); } catch {}
  }
  server.close(() => process.exit(0));
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);