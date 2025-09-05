const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const fs = require('fs-extra');
const axios = require('axios');
const path = require('path');

class WhatsAppBot {
  constructor(io, logger) {
    this.io = io;
    this.log = logger;
    this.sock = null;
    this.isConnectedFlag = false;
    this.groups = [];
    this.retryCount = 0;
    this.maxRetries = 3;
    this.userId = null; // opcional, pode ser setado se usar multi-usuário
  }

  async initialize() {
    try {
      this.log('Iniciando conexão com WhatsApp...', 'info');
      const { state, saveCreds } = await useMultiFileAuthState('./sessions');

      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: { level: 'silent', child: () => ({ level: 'silent' }) },
        browser: ['Auto Envios Bot', 'Chrome', '1.0.0'],
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        generateHighQualityLinkPreview: true
      });

      this.sock.ev.on('creds.update', saveCreds);
      this.sock.ev.on('connection.update', this.handleConnectionUpdate.bind(this));
      this.sock.ev.on('messages.upsert', this.handleMessages.bind(this));

      return true;
    } catch (error) {
      this.log('Erro ao inicializar bot: ' + error.message, 'error');
      throw error;
    }
  }

  handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.log('QR Code recebido', 'info');
      const QRCode = require('qrcode');
      QRCode.toDataURL(qr)
        .then(qrDataUrl => this.io.emit('qrCode', qrDataUrl))
        .catch(err => this.log('Erro ao gerar QR Code: ' + err.message, 'error'));
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      this.log('Conexão fechada. Motivo: ' + lastDisconnect?.error?.output?.statusCode, 'warning');
      this.isConnectedFlag = false;
      this.io.emit('botStatus', { connected: false });
      this.io.emit('qrCode', null);

      if (shouldReconnect && this.retryCount < this.maxRetries) {
        this.retryCount++;
        this.log(`Tentando reconectar... (${this.retryCount}/${this.maxRetries})`, 'info');
        setTimeout(() => this.initialize(), 5000);
      } else if (this.retryCount >= this.maxRetries) {
        this.log('Máximo de tentativas de reconexão atingido', 'error');
        this.retryCount = 0;
      }
    } else if (connection === 'open') {
      this.log('Conectado ao WhatsApp com sucesso!', 'success');
      this.isConnectedFlag = true;
      this.retryCount = 0;
      this.io.emit('botStatus', { connected: true });
      this.io.emit('qrCode', null);

      setTimeout(() => this.loadGroups(), 2000);
    }
  }

  handleMessages(m) {
    try {
      const msg = m.messages[0];
      if (msg?.key?.fromMe === false) {
        this.log('Nova mensagem recebida', 'info');
      }
    } catch { /* ignora erros */ }
  }

  async loadGroups() {
    try {
      if (!this.sock) return;
      this.log('Carregando grupos...', 'info');

      const groups = await this.sock.groupFetchAllParticipating();
      this.groups = Object.values(groups).map(group => ({
        id: group.id,
        name: group.subject || 'Grupo sem nome',
        participants: group.participants ? group.participants.length : 0,
        description: group.desc || '',
        owner: group.owner || ''
      }));

      this.log(`${this.groups.length} grupos carregados`, 'success');
      this.io.emit('groupsList', this.groups);
    } catch (error) {
      this.log('Erro ao carregar grupos: ' + error.message, 'error');
      this.groups = [];
    }
  }

  async getGroups() {
    if (this.groups.length === 0) await this.loadGroups();
    return this.groups;
  }

  async getLatestVideo(youtubeApiKey, channelId) {
    try {
      if (!youtubeApiKey || !channelId) throw new Error('API Key ou Channel ID não configurados');
      this.log('Buscando último vídeo do canal...', 'info');

      const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: { key: youtubeApiKey, channelId, part: 'snippet', order: 'date', maxResults: 1, type: 'video' },
        timeout: 10000
      });

      if (response.data.items?.length > 0) {
        const video = response.data.items[0];
        const videoData = {
          id: video.id.videoId,
          title: video.snippet.title,
          description: video.snippet.description,
          thumbnail: video.snippet.thumbnails.high?.url || video.snippet.thumbnails.default?.url,
          publishedAt: video.snippet.publishedAt,
          url: `https://www.youtube.com/watch?v=${video.id.videoId}`
        };
        this.log(`Vídeo encontrado: ${videoData.title}`, 'success');
        return videoData;
      } else {
        throw new Error('Nenhum vídeo encontrado no canal');
      }
    } catch (error) {
      this.log('Erro ao buscar vídeo: ' + error.message, 'error');
      throw error;
    }
  }

  async sendLatestVideoToGroup(groupId) {
    try {
      if (!this.sock || !this.isConnectedFlag) throw new Error('Bot não conectado');
      const configPath = './config/settings.json';
      let config = {};
      if (await fs.pathExists(configPath)) config = await fs.readJSON(configPath);

      const video = await this.getLatestVideo(config.youtubeApiKey, config.channelId);
      const message = `🎥 *Novo vídeo no canal!*\n\n*${video.title}*\n\n${video.description.substring(0, 200)}${video.description.length > 200 ? '...' : ''}\n\n🔗 ${video.url}`;

      await this.sock.sendMessage(groupId, { text: message });
      this.log(`Vídeo enviado para grupo: ${groupId}`, 'success');
      return true;
    } catch (error) {
      this.log(`Erro ao enviar vídeo para grupo ${groupId}: ${error.message}`, 'error');
      throw error;
    }
  }

  async sendLatestVideo(groupIds) {
    try {
      if (!this.sock || !this.isConnectedFlag) throw new Error('Bot não conectado');
      if (!groupIds?.length) throw new Error('Nenhum grupo selecionado');

      this.log(`Iniciando envio para ${groupIds.length} grupos`, 'info');
      const configPath = './config/settings.json';
      let config = {};
      if (await fs.pathExists(configPath)) config = await fs.readJSON(configPath);

      const video = await this.getLatestVideo(config.youtubeApiKey, config.channelId);
      const message = `🎥 *Novo vídeo no canal!*\n\n*${video.title}*\n\n${video.description.substring(0, 200)}${video.description.length > 200 ? '...' : ''}\n\n🔗 ${video.url}`;

      let successCount = 0, errorCount = 0;

      for (let i = 0; i < groupIds.length; i++) {
        try {
          await this.sock.sendMessage(groupIds[i], { text: message });
          successCount++;
          this.log(`Enviado para grupo ${i + 1}/${groupIds.length}`, 'success');
          if (i < groupIds.length - 1) {
            const delay = config.antiBanSettings?.delayBetweenGroups || 5;
            await new Promise(r => setTimeout(r, delay * 1000));
          }
        } catch (error) {
          errorCount++;
          this.log(`Erro ao enviar para grupo ${i + 1}: ${error.message}`, 'error');
        }
      }

      this.log(`Envio concluído: ${successCount} sucessos, ${errorCount} erros`, 'info');
      return { successCount, errorCount };
    } catch (error) {
      this.log('Erro no envio em lote: ' + error.message, 'error');
      throw error;
    }
  }

  async disconnect() {
    try {
      this.log('Desconectando bot...', 'info');
      this.isConnectedFlag = false;

      if (this.sock) {
        await this.sock.logout();
        this.sock.ev.removeAllListeners();
        this.sock = null;
      }

      this.io.emit('botStatus', { connected: false });
      this.io.emit('qrCode', null);
      this.log('Bot desconectado', 'success');
      return true;
    } catch (error) {
      this.log('Erro ao desconectar: ' + error.message, 'error');
      this.isConnectedFlag = false;
      this.sock = null;
      this.io.emit('botStatus', { connected: false });
      return true;
    }
  }

  isConnected() {
    return this.isConnectedFlag && this.sock;
  }

  async getGroupInfo(groupId) {
    try {
      if (!this.sock || !this.isConnectedFlag) throw new Error('Bot não conectado');
      const groupMetadata = await this.sock.groupMetadata(groupId);
      return {
        id: groupId,
        name: groupMetadata.subject,
        participants: groupMetadata.participants.length,
        description: groupMetadata.desc || '',
        owner: groupMetadata.owner
      };
    } catch (error) {
      this.log(`Erro ao obter info do grupo ${groupId}: ${error.message}`, 'error');
      return null;
    }
  }

  async sendCustomMessage(groupId, message) {
    try {
      if (!this.sock || !this.isConnectedFlag) throw new Error('Bot não conectado');
      await this.sock.sendMessage(groupId, { text: message });
      this.log(`Mensagem personalizada enviada para: ${groupId}`, 'success');
      return true;
    } catch (error) {
      this.log(`Erro ao enviar mensagem para ${groupId}: ${error.message}`, 'error');
      throw error;
    }
  }
}

module.exports = WhatsAppBot;