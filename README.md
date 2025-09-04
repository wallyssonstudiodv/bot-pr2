# Auto Envios Bot - Sistema Multi-usuário

Bot automático multi-usuário para envio de vídeos do YouTube para grupos do WhatsApp com sistema de agendamento avançado, autenticação e proteção anti-banimento.

**Crédito:** Wallysson Studio Dv 2025  
**Lema:** "Você sonha, Deus realiza"

## ✨ Funcionalidades

- 👥 **Sistema Multi-usuário** com login e cadastro
- 🔐 **Autenticação JWT** segura
- 🤖 **Bot WhatsApp isolado** por usuário
- 📅 **Agendamentos personalizados** por grupo e usuário
- 🛡️ **Sistema anti-banimento** configurável
- 🎥 **Busca automática** do último vídeo do canal
- 👥 **Seleção específica** de grupos por agendamento
- 📊 **Logs em tempo real** por usuário
- 🔄 **Reconexão automática**
- 💾 **Dados isolados** por usuário

## 🚀 Instalação

1. **Clone ou baixe os arquivos**
2. **Instale as dependências:**
   ```bash
   npm install
   ```

3. **Crie a estrutura de pastas:**
   ```
   projeto/
   ├── server.js
   ├── package.json
   ├── bot/
   │   └── whatsapp-bot.js
   ├── public/
   │   ├── login.html
   │   └── app.html
   └── data/
       ├── users.json (criado automaticamente)
       └── users/
           └── [userId]/
               ├── settings.json
               └── sessions/
   ```

4. **Inicie o servidor:**
   ```bash
   npm start
   ```

5. **Acesse:** http://localhost:3001

## 📋 Como Usar

### 1. Primeiro Acesso
1. Acesse http://localhost:3001
2. Clique em "Cadastrar"
3. Preencha: usuário, email e senha
4. Faça login com suas credenciais

### 2. Configurar Sistema
1. **YouTube API**: Configure sua API Key e ID do canal
2. **Anti-banimento**: Ajuste delays e limites
3. **WhatsApp**: Conecte escaneando o QR Code

### 3. Criar Agendamentos
1. Clique em "Novo Agendamento"
2. Configure: nome, horário e dias
3. **Selecione grupos específicos**
4. Salve e ative

## 🔧 Estrutura Multi-usuário

### Isolation de Dados
```
data/
├── users.json                    # Base de usuários
└── users/
    ├── [userId1]/
    │   ├── settings.json         # Configurações do usuário
    │   └── sessions/             # Sessão WhatsApp isolada
    └── [userId2]/
        ├── settings.json
        └── sessions/
```

### Autenticação
- **JWT Tokens** com expiração de 24h
- **Senhas criptografadas** com bcrypt
- **Sessões isoladas** por usuário
- **Middleware de proteção** nas APIs

## ⚠️ Segurança

### Dados do Usuário
- Cada usuário tem pasta isolada
- Sessões WhatsApp separadas
- Configurações individuais
- Logs isolados por usuário

### Autenticação
- Tokens JWT seguros
- Logout automático em caso de token inválido
- Validação de entrada em formulários
- Proteção contra ataques comuns

## 🔧 APIs Principais

### Autenticação
```javascript
POST /api/register  // Cadastro
POST /api/login     // Login
POST /api/logout    // Logout
```

### Usuário (Protegidas)
```javascript
GET  /api/config    // Obter configurações
POST /api/config    // Salvar configurações
GET  /api/status    // Status do bot
```

### Socket.IO Events
```javascript
// Autenticação obrigatória via token
initBot, disconnectBot, clearSession
getGroups, sendVideoNow
// Logs isolados por usuário
```

## 📝 Fluxo de Uso

1. **Cadastro/Login** na página inicial
2. **Dashboard** personalizado do usuário
3. **Configuração** YouTube + Anti-banimento
4. **Conexão** WhatsApp (QR Code individual)
5. **Criação** de agendamentos com grupos específicos
6. **Monitoramento** via logs em tempo real

## 🛠️ Troubleshooting

### Problemas de Login
- Verifique credenciais
- Token pode ter expirado (24h)
- Limpe cache do navegador

### Bot não conecta
- Cada usuário tem sessão isolada
- Limpe sessão individual
- Verifique se outro usuário não está usando o mesmo número

### Grupos não aparecem
- Conecte o bot primeiro
- Cada usuário vê apenas seus grupos
- Aguarde carregamento completo

## 🚀 Melhorias da Versão Multi-usuário

### Vs. Versão Single-user
- ✅ **Múltiplos usuários simultâneos**
- ✅ **Isolamento total de dados**
- ✅ **Sistema de autenticação**
- ✅ **Sessões WhatsApp isoladas**
- ✅ **Interface personalizada por usuário**
- ✅ **Logs separados**
- ✅ **Agendamentos independentes**

### Escalabilidade
- Suporta dezenas de usuários simultâneos
- Dados organizados por usuário
- Performance otimizada
- Gerenciamento de memória eficiente

## 📞 Suporte

Desenvolvido por **Wallysson Studio Dv 2025**

### Recursos Adicionais
- Sistema completo de usuários
- Autenticação JWT segura
- Isolamento total entre usuários
- Interface moderna e responsiva

---

⚡ **Dica:** Cada usuário pode usar seu próprio número do WhatsApp e ter configurações completamente independentes!