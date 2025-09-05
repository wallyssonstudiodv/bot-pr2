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
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 horas
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
  
  // Emitir para interface do usuário específico
  if (userId) {
    io.to(`user_${userId}`).emit('log', {
      message,
      type,
      timestamp
    });
  }
}

// Função helper para delay
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Gerenciamento de usuários (arquivo JSON simples)
async function loadUsers() {
  try {
    await fs.ensureDir('./data');
    const usersPath = './data/users.json';
    
    console.log('Tentando carregar usuários de:', path.resolve(usersPath));
    
    if (await fs.pathExists(usersPath)) {
      const data = await fs.readJSON(usersPath);
      console.log('Usuários carregados do arquivo:', Object.keys(data));
      return data;
    }
    
    // Criar arquivo vazio
    const emptyUsers = {};
    await fs.writeJSON(usersPath, emptyUsers, { spaces: 2 });
    console.log('Arquivo users.json criado vazio em:', path.resolve(usersPath));
    return emptyUsers;
  } catch (error) {
    console.error('Erro ao carregar usuários:', error.message);
    console.error('Stack completo:', error.stack);
    return {};
  }
}

async function saveUsers(users) {
  try {
    await fs.ensureDir('./data');
    const usersPath = './data/users.json';
    
    console.log('Tentando salvar usuários:', Object.keys(users));
    console.log('Caminho do arquivo:', path.resolve(usersPath));
    
    await fs.writeJSON(usersPath, users, { spaces: 2 });
    console.log('Arquivo salvo com sucesso');
    
    // Verificar se foi salvo corretamente
    if (await fs.pathExists(usersPath)) {
      const saved = await fs.readJSON(usersPath);
      console.log('Verificação após salvar:', Object.keys(saved));
      
      if (Object.keys(saved).length === Object.keys(users).length) {
        console.log('✅ Usuários salvos corretamente');
        return true;
      } else {
        console.error('❌ Dados não foram salvos corretamente');
        return false;
      }
    } else {
      console.error('❌ Arquivo não foi criado');
      return false;
    }
  } catch (error) {
    console.error('Erro ao salvar usuários:', error.message);
    console.error('Stack completo:', error.stack);
    return false;
  }
}

// Carregar configurações do usuário
async function loadUserConfig(userId) {
  try {
    await fs.ensureDir(`./data/users/${userId}`);
    const configPath = `./data/users/${userId}/settings.json`;
    
    if (await fs.pathExists(configPath)) {
      const config = await fs.readJSON(configPath);
      return { ...defaultUserConfig, ...config };
    }
    
    // Criar arquivo padrão
    await fs.writeJSON(configPath, defaultUserConfig, { spaces: 2 });
    return defaultUserConfig;
  } catch (error) {
    log('Erro ao carregar configurações: ' + error.message, 'error', userId);
    return defaultUserConfig;
  }
}

// Salvar configurações do usuário
async function saveUserConfig(userId, config) {
  try {
    await fs.ensureDir(`./data/users/${userId}`);
    await fs.writeJSON(`./data/users/${userId}/settings.json`, config, { spaces: 2 });
    log('Configurações salvas', 'success', userId);
    return true;
  } catch (error) {
    log('Erro ao salvar configurações: ' + error.message, 'error', userId);
    return false;
  }
}

// Middleware de autenticação
function authenticateToken(req, res, next) {
  const token = req.session.token || req.headers['authorization']?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Token de acesso necessário' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido' });
    }
    req.user = user;
    next();
  });
}

// Middleware de autenticação para Socket.IO
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Token necessário'));
    }

    const user = jwt.verify(token, JWT_SECRET);
    socket.userId = user.id;
    socket.username = user.username;
    
    // Juntar sala do usuário
    socket.join(`user_${user.id}`);
    
    next();
  } catch (error) {
    next(new Error('Token inválido'));
  }
});

// Função para envio com anti-banimento por usuário
async function sendVideoWithAntiBot(userId, groupIds) {
  const userBot = userBots.get(userId);
  if (!userBot || !userBot.isConnected()) {
    throw new Error('Bot não conectado');
  }

  const config = await loadUserConfig(userId);
  const { antiBanSettings } = config;
  const totalGroups = groupIds.length;
  
  log(`Iniciando envio para ${totalGroups} grupos com proteção anti-banimento`, 'info', userId);
  
  // Dividir grupos em lotes
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
        
        // Delay entre grupos (exceto o último do lote)
        if (groupIndex < batch.length - 1) {
          log(`⏳ Aguardando ${antiBanSettings.delayBetweenGroups}s antes do próximo grupo...`, 'info', userId);
          await delay(antiBanSettings.delayBetweenGroups * 1000);
        }
        
      } catch (error) {
        log(`❌ Erro ao enviar para grupo: ${error.message}`, 'error', userId);
      }
    }
    
    // Delay entre lotes (exceto o último)
    if (batchIndex < batches.length - 1) {
      log(`⏳ Aguardando ${antiBanSettings.batchDelay}s antes do próximo lote...`, 'info', userId);
      await delay(antiBanSettings.batchDelay * 1000);
    }
  }
  
  log(`✅ Envio completo: ${sentCount}/${totalGroups} grupos`, 'success', userId);
  return sentCount;
}

// Inicializar bot do usuário
async function initializeUserBot(userId) {
  try {
    log('Inicializando WhatsApp Bot...', 'info', userId);
    
    if (userBots.has(userId)) {
      const existingBot = userBots.get(userId);
      try {
        await existingBot.disconnect();
      } catch (error) {
        log('Aviso ao desconectar bot anterior: ' + error.message, 'warning', userId);
      }
    }
    
    const userBot = new WhatsAppBot(io, log, userId);
    userBots.set(userId, userBot);
    await userBot.initialize();
    
    // Carregar e configurar agendamentos
    const config = await loadUserConfig(userId);
    setupUserSchedules(userId, config.schedules, config);
    
    log('Bot inicializado com sucesso', 'success', userId);
    return true;
  } catch (error) {
    log('Erro ao inicializar bot: ' + error.message, 'error', userId);
    return false;
  }
}

// Configurar agendamentos do usuário
function setupUserSchedules(userId, schedules, config) {
  try {
    // Limpar agendamentos existentes do usuário
    if (activeTasks.has(userId)) {
      const userTasks = activeTasks.get(userId);
      userTasks.forEach(task => {
        try {
          task.destroy();
        } catch (error) {
          log('Erro ao limpar tarefa: ' + error.message, 'warning', userId);
        }
      });
      userTasks.clear();
    } else {
      activeTasks.set(userId, new Map());
    }
    
    if (!schedules || schedules.length === 0) {
      log('Nenhum agendamento para configurar', 'info', userId);
      return;
    }
    
    const userTasks = activeTasks.get(userId);
    
    schedules.forEach(schedule => {
      if (schedule.active && schedule.days && schedule.days.length > 0 && schedule.selectedGroups && schedule.selectedGroups.length > 0) {
        const cronDays = schedule.days.join(',');
        const cronTime = `${schedule.minute} ${schedule.hour} * * ${cronDays}`;
        
        log(`Configurando agendamento: ${schedule.name} - ${cronTime} - ${schedule.selectedGroups.length} grupos`, 'info', userId);
        
        const task = cron.schedule(cronTime, async () => {
          const userBot = userBots.get(userId);
          if (userBot && userBot.isConnected()) {
            try {
              log(`🕐 Executando agendamento: ${schedule.name}`, 'info', userId);
              await sendVideoWithAntiBot(userId, schedule.selectedGroups);
              log(`✅ Agendamento executado: ${schedule.name}`, 'success', userId);
            } catch (error) {
              log(`❌ Erro no agendamento ${schedule.name}: ${error.message}`, 'error', userId);
            }
          } else {
            log(`⚠️ Bot desconectado - agendamento ${schedule.name} ignorado`, 'warning', userId);
          }
        }, {
          scheduled: false,
          timezone: "America/Sao_Paulo"
        });
        
        task.start();
        userTasks.set(schedule.id, task);
        
        log(`✅ Agendamento ativo: ${schedule.name}`, 'success', userId);
      } else {
        log(`⚠️ Agendamento inválido ignorado: ${schedule.name}`, 'warning', userId);
      }
    });
    
    log(`📅 ${userTasks.size} agendamentos configurados`, 'info', userId);
  } catch (error) {
    log('Erro ao configurar agendamentos: ' + error.message, 'error', userId);
  }
}

// Socket.IO eventos
io.on('connection', (socket) => {
  const userId = socket.userId;
  const username = socket.username;
  
  log(`Cliente conectado: ${username}`, 'info', userId);
  
  // Enviar status atual do bot do usuário
  socket.emit('botStatus', {
    connected: userBots.has(userId) && userBots.get(userId).isConnected()
  });
  
  // Inicializar bot
  socket.on('initBot', async () => {
    log('Solicitação de inicialização do bot', 'info', userId);
    const success = await initializeUserBot(userId);
    socket.emit('initResult', { success });
  });
  
  // Desconectar bot
  socket.on('disconnectBot', async () => {
    log('Solicitação de desconexão do bot', 'info', userId);
    
    try {
      // Parar agendamentos do usuário
      if (activeTasks.has(userId)) {
        const userTasks = activeTasks.get(userId);
        userTasks.forEach(task => {
          try {
            task.destroy();
          } catch (error) {
            log('Erro ao parar tarefa: ' + error.message, 'warning', userId);
          }
        });
        userTasks.clear();
      }
      
      // Desconectar bot do usuário
      if (userBots.has(userId)) {
        const userBot = userBots.get(userId);
        await userBot.disconnect();
        userBots.delete(userId);
      }
      
      socket.emit('disconnectResult', { success: true });
      socket.emit('botStatus', { connected: false });
      log('Bot desconectado com sucesso', 'success', userId);
    } catch (error) {
      log('Erro ao desconectar: ' + error.message, 'error', userId);
      socket.emit('disconnectResult', { success: false, error: error.message });
    }
  });
  
  // Limpar sessão
  socket.on('clearSession', async () => {
    log('Solicitação de limpeza de sessão', 'info', userId);
    
    try {
      // Parar agendamentos
      if (activeTasks.has(userId)) {
        const userTasks = activeTasks.get(userId);
        userTasks.forEach(task => {
          try {
            task.destroy();
          } catch (error) {
            log('Erro ao parar tarefa: ' + error.message, 'warning', userId);
          }
        });
        userTasks.clear();
      }
      
      // Desconectar bot
      if (userBots.has(userId)) {
        const userBot = userBots.get(userId);
        await userBot.disconnect();
        userBots.delete(userId);
      }
      
      // Aguardar um pouco para garantir desconexão
      await delay(2000);
      
      // Limpar diretório de sessões do usuário
      const sessionsPath = `./data/users/${userId}/sessions`;
      if (await fs.pathExists(sessionsPath)) {
        await fs.remove(sessionsPath);
        log('Diretório de sessões removido', 'info', userId);
      }
      
      // Recriar diretório vazio
      await fs.ensureDir(sessionsPath);
      
      socket.emit('clearSessionResult', { success: true });
      socket.emit('botStatus', { connected: false });
      log('Sessão limpa com sucesso', 'success', userId);
    } catch (error) {
      log('Erro ao limpar sessão: ' + error.message, 'error', userId);
      socket.emit('clearSessionResult', { success: false, error: error.message });
    }
  });
  
  // Obter grupos
  socket.on('getGroups', async () => {
    log('Solicitação de lista de grupos', 'info', userId);
    
    const userBot = userBots.get(userId);
    if (userBot && userBot.isConnected()) {
      try {
        const groups = await userBot.getGroups();
        socket.emit('groupsList', groups);
        log(`${groups.length} grupos enviados para interface`, 'info', userId);
      } catch (error) {
        log('Erro ao obter grupos: ' + error.message, 'error', userId);
        socket.emit('groupsList', []);
      }
    } else {
      log('Bot não conectado para buscar grupos', 'warning', userId);
      socket.emit('groupsList', []);
    }
  });
  
  // Enviar vídeo manual
  socket.on('sendVideoNow', async (groupIds) => {
    log(`Envio manual solicitado para ${groupIds.length} grupos`, 'info', userId);
    
    const userBot = userBots.get(userId);
    if (userBot && userBot.isConnected()) {
      try {
        await sendVideoWithAntiBot(userId, groupIds);
        socket.emit('sendResult', { success: true });
        log('✅ Envio manual concluído', 'success', userId);
      } catch (error) {
        log('❌ Erro no envio manual: ' + error.message, 'error', userId);
        socket.emit('sendResult', { success: false, error: error.message });
      }
    } else {
      const errorMsg = 'Bot não conectado';
      log('❌ ' + errorMsg, 'error', userId);
      socket.emit('sendResult', { success: false, error: errorMsg });
    }
  });
  
  socket.on('disconnect', () => {
    log(`Cliente desconectado: ${username}`, 'info', userId);
  });
});

// Rotas de autenticação
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    console.log('=== DEBUG REGISTER ===');
    console.log('Username:', username);
    console.log('Email:', email);
    console.log('Password fornecida:', !!password);
    
    if (!username || !email || !password) {
      console.log('❌ Campos obrigatórios faltando');
      return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
    }
    
    if (password.length < 6) {
      console.log('❌ Senha muito curta');
      return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
    }
    
    const users = await loadUsers();
    console.log('Usuários existentes antes do cadastro:', Object.keys(users));
    
    // Verificar se usuário já existe
    if (users[username] || Object.values(users).some(u => u.email === email)) {
      console.log('❌ Usuário ou email já existe');
      return res.status(400).json({ error: 'Usuário ou email já existe' });
    }
    
    // Hash da senha
    console.log('Criando hash da senha...');
    const hashedPassword = await bcrypt.hash(password, 10);
    console.log('Hash da senha criado');
    
    // Criar usuário
    const userId = Date.now().toString();
    const newUser = {
      id: userId,
      username,
      email,
      password: hashedPassword,
      createdAt: new Date().toISOString()
    };
    
    users[username] = newUser;
    
    console.log('Usuário criado na memória:', {
      id: userId,
      username,
      email,
      hasPassword: !!hashedPassword
    });
    
    // Salvar no arquivo
    console.log('Salvando usuário no arquivo...');
    const saved = await saveUsers(users);
    
    if (saved) {
      console.log('✅ Usuário salvo no arquivo');
      
      // Criar diretório do usuário
      try {
        await fs.ensureDir(`./data/users/${userId}`);
        await fs.ensureDir(`./data/users/${userId}/sessions`);
        console.log('✅ Diretórios do usuário criados');
      } catch (dirError) {
        console.error('Erro ao criar diretórios:', dirError);
      }
      
      log(`Novo usuário registrado: ${username}`, 'info');
      
      res.json({ success: true, message: 'Usuário criado com sucesso' });
    } else {
      console.log('❌ Erro ao salvar usuário');
      res.status(500).json({ error: 'Erro ao salvar usuário no arquivo' });
    }
  } catch (error) {
    console.error('Erro no registro:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    console.log('=== DEBUG LOGIN ===');
    console.log('Username recebido:', username);
    console.log('Password recebido:', password ? '[SENHA FORNECIDA]' : '[SEM SENHA]');
    
    if (!username || !password) {
      console.log('❌ Campos obrigatórios faltando');
      return res.status(400).json({ error: 'Username e senha são obrigatórios' });
    }
    
    // Carregar usuários
    const users = await loadUsers();
    console.log('Usuários carregados:', Object.keys(users));
    console.log('Total de usuários:', Object.keys(users).length);
    
    // Debug: mostrar estrutura do primeiro usuário
    if (Object.keys(users).length > 0) {
      const firstUserKey = Object.keys(users)[0];
      const firstUser = users[firstUserKey];
      console.log('Estrutura do primeiro usuário:', {
        key: firstUserKey,
        username: firstUser.username,
        hasPassword: !!firstUser.password,
        email: firstUser.email
      });
    }
    
    // Buscar usuário
    const user = users[username];
    console.log('Usuário encontrado:', !!user);
    
    if (!user) {
      console.log('❌ Usuário não encontrado na base');
      console.log('Usuários disponíveis:', Object.keys(users));
      return res.status(400).json({ error: 'Usuário não encontrado' });
    }
    
    console.log('Verificando senha...');
    
    // Verificar senha
    const passwordValid = await bcrypt.compare(password, user.password);
    console.log('Senha válida:', passwordValid);
    
    if (!passwordValid) {
      console.log('❌ Senha incorreta');
      return res.status(400).json({ error: 'Senha incorreta' });
    }
    
    // Gerar token JWT
    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    // Salvar token na sessão
    req.session.token = token;
    req.session.userId = user.id;
    req.session.username = user.username;
    
    console.log('✅ Login bem-sucedido');
    log(`Usuário logado: ${username}`, 'info', user.id);
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Rota de debug - REMOVER EM PRODUÇÃO
app.get('/debug/users', async (req, res) => {
  try {
    const users = await loadUsers();
    const usersPath = './data/users.json';
    const exists = await fs.pathExists(usersPath);
    const stats = exists ? await fs.stat(usersPath) : null;
    
    res.json({
      usersCount: Object.keys(users).length,
      users: Object.keys(users),
      fileExists: exists,
      fileSize: stats ? stats.size : 0,
      filePath: path.resolve(usersPath),
      workingDirectory: process.cwd()
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Rotas principais
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/app', authenticateToken, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// API protegida - Salvar configurações
app.post('/api/config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    log('Solicitação de salvamento de configurações', 'info', userId);
    
    const config = await loadUserConfig(userId);
    const newConfig = { ...config, ...req.body };
    
    const saved = await saveUserConfig(userId, newConfig);
    
    if (saved && req.body.schedules) {
      setupUserSchedules(userId, req.body.schedules, newConfig);
    }
    
    res.json({ success: saved });
  } catch (error) {
    log('Erro na API de configuração: ' + error.message, 'error', req.user.id);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API protegida - Obter configurações
app.get('/api/config', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const config = await loadUserConfig(userId);
    res.json(config);
  } catch (error) {
    log('Erro ao obter configurações: ' + error.message, 'error', req.user.id);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Rota de status
app.get('/api/status', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const userBot = userBots.get(userId);
  const userTasks = activeTasks.get(userId);
  
  res.json({
    botConnected: userBot ? userBot.isConnected() : false,
    activeSchedules: userTasks ? userTasks.size : 0,
    uptime: process.uptime()
  });
});

// Tratamento de erros globais
process.on('uncaughtException', (error) => {
  console.error('Erro não capturado:', error.message);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promise rejeitada:', reason);
  console.error('Promise rejeitada em:', promise, 'razão:', reason);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Encerrando aplicação...');
  
  // Desconectar todos os bots
  for (const [userId, bot] of userBots) {
    try {
      await bot.disconnect();
      log('Bot desconectado', 'info', userId);
    } catch (error) {
      log('Erro ao desconectar bot: ' + error.message, 'warning', userId);
    }
  }
  
  // Parar todas as tarefas
  for (const [userId, tasks] of activeTasks) {
    tasks.forEach(task => {
      try {
        task.destroy();
      } catch (error) {
        log('Erro ao parar tarefa: ' + error.message, 'warning', userId);
      }
    });
  }
  
  server.close(() => {
    console.log('Servidor encerrado');
    process.exit(0);