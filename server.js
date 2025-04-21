// backend/server.js
require('dotenv').config(); // Carrega as variáveis de ambiente do ficheiro .env

const http = require('http');
const { Server } = require("socket.io"); // Importar Server do socket.io
const app = require('./src/app'); // Importa a configuração da aplicação Express
const initializeSocketIO = require('./src/sockets'); // Importaremos a lógica de sockets daqui
// Imports para o Agendador
const cron = require('node-cron');
const { pool } = require('./src/config/database'); // Para fazer query direta
const campaignService = require('./src/services/campaignService'); // Para chamar startCampaign
const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/users');
const campaignRoutes = require('./src/routes/campaigns');
const statsRoutes = require('./src/routes/stats');

const PORT = process.env.PORT || 3000; // Usa a porta do .env ou 3000 como padrão

// Cria o servidor HTTP usando a app Express
const httpServer = http.createServer(app);

// Cria a instância do servidor Socket.IO anexada ao servidor HTTP
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173", // Restringir ao URL do frontend do .env
    methods: ["GET", "POST"],
    credentials: true // Permitir envio de cookies/credenciais se necessário
  }
});

// Associar a instância io à aplicação Express para acesso nos controladores/serviços
app.set('io', io);

// Inicializa a lógica de tratamento de eventos do Socket.IO
initializeSocketIO(io);

// Rotas da API
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/stats', statsRoutes);

// --- Configuração do Agendador (node-cron) ---
// Correr a cada minuto (* * * * *)
console.log('⏰ Agendador de campanhas configurado para correr a cada minuto.');
cron.schedule('* * * * *', async () => {
  console.log('⏰ Verificando campanhas agendadas...');
  const client = await pool.connect();
  try {
    // Buscar campanhas agendadas que já passaram da hora e não foram iniciadas
    const result = await client.query(
      `SELECT id, user_id 
       FROM campaigns 
       WHERE status = 'scheduled' AND scheduled_at <= NOW()`
    );

    if (result.rows.length > 0) {
      console.log(`⏰ Encontradas ${result.rows.length} campanhas agendadas para iniciar.`);
      
      // Iniciar cada campanha encontrada
      for (const campaign of result.rows) {
        console.log(`⏰ Tentando iniciar automaticamente a campanha agendada ${campaign.id} para user ${campaign.user_id}...`);
        try {
          // É crucial ter a instância `io` disponível aqui!
          await campaignService.startCampaign(campaign.id, campaign.user_id, io);
          // O startCampaign já muda o status para 'sending' ou 'completed' ou 'failed'
          console.log(`✅ Campanha agendada ${campaign.id} iniciada com sucesso.`);
        } catch (startError) {
          console.error(`❌ Erro ao iniciar automaticamente a campanha agendada ${campaign.id}:`, startError.message);
          // Marcar como falha se o start falhou (ex: dispositivo offline)
          // O startCampaign já tenta fazer isso no seu bloco catch, mas podemos reforçar
          await client.query(
             `UPDATE campaigns SET status = 'failed', updated_at = NOW() 
              WHERE id = $1 AND status = 'scheduled'`, // Só atualiza se ainda estiver scheduled
             [campaign.id]
          ).catch(updateErr => console.error(`Falha ao atualizar status para falha da campanha ${campaign.id}:`, updateErr));
        }
      }
    } else {
      // console.log('⏰ Nenhuma campanha agendada encontrada para iniciar neste minuto.');
    }
  } catch (cronError) {
    console.error('❌ Erro geral no job do agendador de campanhas:', cronError);
  } finally {
    client.release();
  }
});
// --- Fim Agendador ---

httpServer.listen(PORT, '0.0.0.0', () => { // Iniciar o httpServer em todas as interfaces de rede
  console.log(`🚀 Servidor backend (HTTP + Socket.IO) a correr na porta ${PORT} em todas as interfaces`);
  console.log(`🔗 Ambiente: ${process.env.NODE_ENV}`);
});

// TODO: Configurar Socket.IO aqui mais tarde, anexando ao servidor HTTP 