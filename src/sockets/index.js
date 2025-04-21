// backend/src/sockets/index.js
const { query, pool } = require('../config/database'); // <-- ADICIONAR pool AQUI

// Novo Mapa para guardar: email -> { socketId, deviceId }
const connectedAndroidApps = new Map(); 

// Nova função para encontrar informações do socket pelo email
function getSocketInfoForEmail(targetEmail) {
  return connectedAndroidApps.get(targetEmail); // Retorna { socketId, deviceId } ou undefined
}

function initializeSocketIO(io) {
  console.log('🔌 Inicializando Socket.IO (com autenticação por email via evento)...');

  io.on('connection', (socket) => {
    // Conexão inicial - não sabemos quem é ainda
    console.log(`⚡ Cliente conectado (Socket ID: ${socket.id}) - Aguardando autenticação...`);

    // Adicionar listener para joinUserRoom
    socket.on('joinUserRoom', () => {
        // Tentar obter o email associado a este socket (se já se autenticou)
        let userEmail = null;
        for (let [email, socketInfo] of connectedAndroidApps.entries()) {
            if (socketInfo.socketId === socket.id) {
                userEmail = email;
                break;
            }
        }
        // TODO: Precisamos de uma forma de saber o user_id do frontend.
        // Por agora, vamos logar a tentativa.
        // ASSUMINDO que obtemos o ID do user do token JWT da web app (ex: via middleware)
        const userIdFromFrontend = socket.userData?.id || 3; // Usar ID 3 se não houver dados do middleware (para teste)
        if (userIdFromFrontend) {
            const roomName = `user_${userIdFromFrontend}`;
            socket.join(roomName);
            console.log(`[Socket Room] Socket ${socket.id} (Email: ${userEmail || 'N/A'}, UserID: ${userIdFromFrontend}) entrou na sala ${roomName}`);
        } else {
            console.warn(`[Socket Room] Tentativa de joinUserRoom por socket ${socket.id} sem UserID identificável.`);
        }
    });

    // --- NOVO Listener para Autenticação da App Android ---
    socket.on('authenticate_android', async (data) => {
      const deviceId = data?.deviceId;
      const email = data?.email;

      if (!deviceId || !email) {
        console.warn(`[Socket ${socket.id}] Evento 'authenticate_android' recebido sem deviceId ou email.`, data);
        socket.emit('registrationError', { message: 'deviceId e email são obrigatórios.' });
        return;
      }

      // Verificar se este email já está conectado com outro socket? (Opcional, depende da regra de negócio)
      const existingSocketInfo = connectedAndroidApps.get(email);
      if (existingSocketInfo && existingSocketInfo.socketId !== socket.id) {
          console.warn(`[Socket ${socket.id}] Tentativa de registo para email ${email} que já está associado ao socket ${existingSocketInfo.socketId}. Desconectando socket antigo?`);
          // Opcional: Desconectar o socket antigo ou rejeitar a nova conexão
          const oldSocket = io.sockets.sockets.get(existingSocketInfo.socketId);
          oldSocket?.disconnect(true); // Força desconexão do socket antigo
      }

      // Armazenar a associação: email -> { socketId, deviceId }
      connectedAndroidApps.set(email, { socketId: socket.id, deviceId: deviceId });
      console.log(`📱 App Android autenticada: Email=${email}, DeviceID=${deviceId}, SocketID=${socket.id}`);
      
      // Tentar atualizar na DB (assumindo que ainda temos a tabela devices)
      // ATENÇÃO: Precisamos do user_id! Como obter? Buscar pelo email?
      // Por agora, vamos simplificar e apenas emitir sucesso.
      socket.emit('registrationSuccess', { message: 'Dispositivo autenticado com sucesso via Socket.' });

    });

    // -- Eventos de Status da App para o Backend --
    socket.on('smsStatusUpdate', async (data) => {
      const { recipientId, status, errorMessage } = data;

      if (!recipientId || !status) {
        console.warn(`[Socket ${socket.id}] Recebido smsStatusUpdate inválido:`, data);
        return; // Dados mínimos necessários
      }

      console.log(`[Socket ${socket.id}] Recebido smsStatusUpdate para recipient ${recipientId}: Status=${status}, Error=${errorMessage || 'N/A'}`);

      const client = await pool.connect(); // Usar pool para transação
      let campaignIdForNotification = null; // Guardar ID para buscar contagens depois
      let userIdForNotification = null; // Guardar User ID para a sala

      try {
        await client.query('BEGIN');

        // 1. Atualizar Recipient e obter campaign_id
        const updateRecipientQuery = `
          UPDATE recipients
          SET status = $1, error_message = $2, updated_at = NOW()
          WHERE id = $3
          RETURNING campaign_id, status;
        `;
        const recipientResult = await client.query(updateRecipientQuery, [status, errorMessage, recipientId]);

        if (recipientResult.rowCount === 0) {
          console.warn(`[DB Update] Recipient ${recipientId} não encontrado. Status não atualizado.`);
          await client.query('ROLLBACK');
          return;
        }
        const updatedRecipient = recipientResult.rows[0];
        const campaignId = updatedRecipient.campaign_id;
        const finalStatus = updatedRecipient.status;
        campaignIdForNotification = campaignId; // Guardar ID

        // 2. Atualizar Contadores da Campanha - MODIFICADO para considerar delivered/delivery_failed
        let updateCampaignQuery = '';
        if (finalStatus === 'delivered') {
          // Para entrega confirmada, incrementar contador de sucesso
          updateCampaignQuery = 'UPDATE campaigns SET success_count = success_count + 1, updated_at = NOW() WHERE id = $1';
        } else if (finalStatus === 'sent') {
          // Para mensagens apenas enviadas, NÃO incrementar contador - apenas atualizar timestamp
          updateCampaignQuery = 'UPDATE campaigns SET updated_at = NOW() WHERE id = $1';
        } else if (finalStatus === 'failed' || finalStatus === 'delivery_failed') {
          // Para falhas (tanto de envio quanto de entrega), incrementamos o contador de falhas
          updateCampaignQuery = 'UPDATE campaigns SET failure_count = failure_count + 1, updated_at = NOW() WHERE id = $1';
        }
        
        if (updateCampaignQuery) {
            await client.query(updateCampaignQuery, [campaignId]);
        }

        await client.query('COMMIT');
        console.log(`[DB Update] Status do recipient ${recipientId} (${finalStatus}) e contadores da campanha ${campaignId} atualizados.`);

        // 3. Buscar Contagens Atualizadas e User ID para Notificação
        if (campaignIdForNotification) {
            const countsResult = await client.query(
                'SELECT c.user_id, c.name, c.status, c.success_count, c.failure_count, c.recipients_total FROM campaigns c WHERE c.id = $1',
                [campaignIdForNotification]
            );
            const campaignData = countsResult.rows[0];
            if (campaignData) {
                userIdForNotification = campaignData.user_id;
                
                // Garantir que os valores são números válidos
                const successCount = Number(campaignData.success_count) || 0;
                const failureCount = Number(campaignData.failure_count) || 0;
                const totalRecipients = Number(campaignData.recipients_total) || 0;
                const percentComplete = totalRecipients > 0 ? Math.round((successCount + failureCount) / totalRecipients * 100) : 0;
                
                console.log(`[Campanha] "${campaignData.name}" - Progresso: ${successCount}/${totalRecipients} mensagens (${percentComplete}%)`);
                console.log(`[Socket Emit] Prepared campaignProgress data:`, {
                    campaignId: campaignIdForNotification,
                    campaignName: campaignData.name,
                    successCount,
                    failureCount,
                    totalRecipients,
                    totalProcessed: successCount + failureCount,
                    percentComplete
                });
                
                // Emitir evento COM as contagens
                const ioInstance = socket.server;
                
                // Log antes de emitir campaignProgress
                console.log(`%c[Socket Emit -> Dashboard] ENVIANDO 'campaignProgress' PARA user_${userIdForNotification} VIA smsStatusUpdate`, 'color: black; background-color: #ffc107;', {
                    campaignId: campaignIdForNotification,
                    campaignName: campaignData.name,
                    recipientId: recipientId, 
                    status: finalStatus,      
                    errorMessage: errorMessage,
                    successCount,
                    failureCount,
                    totalRecipients,
                    percentComplete
                });
                
                ioInstance.to(`user_${userIdForNotification}`).emit('campaignProgress', {
                    campaignId: campaignIdForNotification,
                    campaignName: campaignData.name,
                    recipientId: recipientId,
                    status: finalStatus,
                    errorMessage: errorMessage,
                    successCount,
                    failureCount,
                    totalRecipients,
                    percentComplete
                });
                
                // Verificar se a campanha terminou
                if (successCount + failureCount >= totalRecipients && totalRecipients > 0) {
                    // Atualizar o status da campanha para 'completed' se todos os recipients foram processados
                    const updateStatusResult = await client.query(
                        'UPDATE campaigns SET status = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2 AND status = $3 RETURNING id',
                        ['completed', campaignIdForNotification, 'sending']
                    );
                    
                    if (updateStatusResult.rowCount > 0) {
                        console.log(`[DB Update] Campanha "${campaignData.name}" (ID: ${campaignIdForNotification}) marcada como 'completed' automaticamente.`);
                        console.log(`[Campanha] "${campaignData.name}" - CONCLUÍDA! Resultado final: ${successCount}/${totalRecipients} mensagens (${percentComplete}%)`);
                        
                        // Log antes de emitir campaignStatusUpdate (completed)
                        console.log(`%c[Socket Emit -> Dashboard] ENVIANDO 'campaignStatusUpdate' (completed) PARA user_${userIdForNotification} VIA smsStatusUpdate`, 'color: white; background-color: #28a745;', {
                            campaignId: campaignIdForNotification,
                            campaignName: campaignData.name,
                            status: 'completed',
                            percentComplete
                        });
                        
                        // Emitir evento de atualização de status
                        ioInstance.to(`user_${userIdForNotification}`).emit('campaignStatusUpdate', {
                            campaignId: campaignIdForNotification,
                            campaignName: campaignData.name,
                            status: 'completed',
                            percentComplete
                        });
                        
                        // Log antes de emitir activeCampaignUpdate (null)
                         console.log(`%c[Socket Emit -> Dashboard] ENVIANDO 'activeCampaignUpdate' (null) PARA user_${userIdForNotification} VIA smsStatusUpdate`, 'color: white; background-color: #dc3545;');
                         
                        // Emitir evento de campanha ativa adicional
                        ioInstance.to(`user_${userIdForNotification}`).emit('activeCampaignUpdate', null);
                    }
                } else {
                    // Emitir evento de campanha ativa atualizada
                    // Isso garante que o frontend receba atualizações em tempo real da campanha ativa
                    if (campaignData.status === 'sending') {
                        const activeCampaignData = {
                            id: campaignIdForNotification,
                            name: campaignData.name,
                            status: campaignData.status,
                            success_count: successCount,
                            failure_count: failureCount,
                            recipients_total: totalRecipients,
                            percentComplete
                        };
                        
                        // Log antes de emitir activeCampaignUpdate (dados)
                        console.log(`%c[Socket Emit -> Dashboard] ENVIANDO 'activeCampaignUpdate' (dados) PARA user_${userIdForNotification} VIA smsStatusUpdate`, 'color: white; background-color: #007bff;', activeCampaignData);
                        
                        ioInstance.to(`user_${userIdForNotification}`).emit('activeCampaignUpdate', activeCampaignData);
                    }
                }
            } else {
                console.warn(`[Socket Emit] Não foi possível buscar contagens atualizadas para campanha ${campaignIdForNotification}.`);
            }
        }

      } catch (dbError) {
        await client.query('ROLLBACK');
        console.error(`[DB Error] Erro ao atualizar status/contagens para recipient ${recipientId}:`, dbError);
      } finally {
        client.release();
      }
    });

    // Listener para solicitar campanha ativa atual
    socket.on('requestActiveCampaign', async () => {
        const userId = getUserIdFromSocket(socket);
        if (!userId) {
            console.warn(`[Socket ${socket.id}] requestActiveCampaign de socket não autenticado`);
            return;
        }
        
        console.log(`[Socket ${socket.id}] Solicitação de campanha ativa para o usuário ID: ${userId}`);
        
        try {
            // ALTERAÇÃO: Buscar campanha ativa/em progresso (não apenas 'sending')
            console.log("[Socket requestActiveCampaign] Procurando campanha com status NOT IN ('completed', 'failed', 'draft', 'pending', 'scheduled')");
            const result = await pool.query(
                `SELECT c.*, COUNT(r.id) as recipients_total,
                  SUM(CASE WHEN r.status = 'delivered' THEN 1 ELSE 0 END) as success_count,
                  SUM(CASE WHEN r.status IN ('failed', 'delivery_failed') THEN 1 ELSE 0 END) as failure_count
                FROM campaigns c
                LEFT JOIN recipients r ON c.id = r.campaign_id
                WHERE c.user_id = $1 
                  AND c.status NOT IN ('completed', 'failed', 'draft', 'pending', 'scheduled') 
                  -- Adicionar outros status finais/iniciais se existirem
                GROUP BY c.id
                ORDER BY c.started_at DESC, c.created_at DESC -- Priorizar por início, depois criação
                LIMIT 1`,
                [userId]
            );
            
            if (result.rows.length === 0) {
                console.log(`[Socket ${socket.id}] Nenhuma campanha ativa/em progresso encontrada para user ${userId}`);
                
                // Log ANTES de emitir null
                console.log(`%c[Socket Emit -> Dashboard] ENVIANDO 'activeCampaignUpdate' (null - Nenhuma ativa encontrada) PARA socket ${socket.id} VIA requestActiveCampaign`, 'color: white; background-color: #ffc107; color: black;');
                socket.emit('activeCampaignUpdate', null);
                return;
            }
            
            const campaign = result.rows[0];
            // Calcular percentagem
            const successCount = Number(campaign.success_count) || 0;
            const failureCount = Number(campaign.failure_count) || 0;
            const totalRecipients = Number(campaign.recipients_total) || 0;
            const percentComplete = totalRecipients > 0 ? Math.round((successCount + failureCount) / totalRecipients * 100) : 0;
            
            console.log(`[Campanha] Campanha ativa encontrada: "${campaign.name}" (${successCount}/${totalRecipients} - ${percentComplete}%)`);
            
            // Adicionar percentagem aos dados da campanha
            const campaignWithPercent = {
                ...campaign,
                percentComplete
            };
            
            // Log antes de emitir activeCampaignUpdate
            console.log(`%c[Socket Emit -> Dashboard] ENVIANDO 'activeCampaignUpdate' PARA socket ${socket.id} VIA requestActiveCampaign`, 'color: white; background-color: #007bff;', campaignWithPercent);
            
            socket.emit('activeCampaignUpdate', campaignWithPercent);
        } catch (err) {
            console.error(`[Socket] Erro ao buscar campanha ativa para user ${userId}:`, err);
            
            // Log antes de emitir activeCampaignUpdate (null em caso de erro)
            console.log(`%c[Socket Emit -> Dashboard] ENVIANDO 'activeCampaignUpdate' (null - erro) PARA socket ${socket.id} VIA requestActiveCampaign`, 'color: white; background-color: #dc3545;');
            
            socket.emit('activeCampaignUpdate', null);
        }
    });

    socket.on('deviceStatusUpdate', (data) => {
        // Armazenar os dados de status recebidos do dispositivo
        const email = getEmailForSocketId(socket.id);
        if (!email) {
            console.warn(`[Socket ${socket.id}] Evento 'deviceStatusUpdate' recebido de um socket não autenticado`);
            return;
        }

        // Atualizar informações do dispositivo no Map
        const socketInfo = connectedAndroidApps.get(email);
        if (socketInfo) {
            // Mesclar os dados novos com os existentes
            connectedAndroidApps.set(email, { 
                ...socketInfo, 
                ...data,
                lastStatusUpdate: new Date()
            });
            console.log(`[Socket ${socket.id}] Status do dispositivo atualizado para ${email}:`, data);
        }
    });

    // Novo handler para solicitar status do dispositivo
    socket.on('requestDeviceStatus', () => {
        // Verificar se este é um socket web (não Android)
        const userId = getUserIdFromSocket(socket);
        if (!userId) {
            console.warn(`[Socket ${socket.id}] requestDeviceStatus de socket não autenticado`);
            return;
        }

        console.log(`[Socket ${socket.id}] Solicitando status do dispositivo para o usuário ID: ${userId}`);

        // Buscar email do usuário a partir do userId (poderia ser uma consulta ao banco)
        // Assumindo que temos uma função getUserEmailById
        getUserEmailById(userId)
            .then(email => {
                if (!email) {
                    console.warn(`[Socket ${socket.id}] Não foi possível encontrar email para user ${userId}`);
                    socket.emit('deviceStatusUpdate', {
                        isConnected: false,
                        batteryLevel: 0,
                        smsPackage: 'Não foi possível encontrar o dispositivo',
                        deviceModel: 'Não foi possível encontrar o dispositivo'
                    });
                    return;
                }

                console.log(`[Socket ${socket.id}] Email encontrado para userID ${userId}: ${email}`);

                // Verificar se há um dispositivo conectado para este email
                const deviceInfo = connectedAndroidApps.get(email);
                if (!deviceInfo) {
                    // Não há dispositivo conectado, enviar status vazio
                    console.log(`[Socket ${socket.id}] Nenhum dispositivo encontrado para o email: ${email}`);
                    socket.emit('deviceStatusUpdate', {
                        isConnected: false,
                        batteryLevel: 0,
                        smsPackage: 'Nenhum dispositivo conectado',
                        deviceModel: 'Nenhum dispositivo conectado'
                    });
                    return;
                }

                // Enviar status atualizado para o frontend
                console.log(`[Socket ${socket.id}] Enviando status do dispositivo para o frontend:`, deviceInfo);
                socket.emit('deviceStatusUpdate', {
                    isConnected: true,
                    batteryLevel: deviceInfo.batteryLevel || 0, 
                    smsPackage: deviceInfo.smsPackage || 'Desconhecido',
                    deviceModel: deviceInfo.deviceModel || 'Dispositivo desconhecido'
                });

                // Solicitar uma atualização fresca do dispositivo Android
                const androidSocket = io.sockets.sockets.get(deviceInfo.socketId);
                if (androidSocket) {
                    console.log(`[Socket] Solicitando atualização de status do dispositivo para socket ${deviceInfo.socketId}`);
                    androidSocket.emit('requestDeviceStatus');
                }
            })
            .catch(err => {
                console.error(`[Socket] Erro ao buscar email para user ${userId}:`, err);
                socket.emit('deviceStatusUpdate', {
                    isConnected: false,
                    batteryLevel: 0,
                    smsPackage: 'Erro ao obter informações',
                    deviceModel: 'Erro ao obter informações'
                });
            });
    });

    // -- Tratamento de Desconexão --
    socket.on('disconnect', (reason) => {
      // Encontrar e remover a entrada do novo Map `connectedAndroidApps`
      let disconnectedEmail = null;
      for (let [email, socketInfo] of connectedAndroidApps.entries()) {
          if (socketInfo.socketId === socket.id) {
              disconnectedEmail = email;
              connectedAndroidApps.delete(email);
              break;
          }
      }
      console.log(`🔌 Cliente desconectado: Socket ID=${socket.id}, Email=${disconnectedEmail || 'Não autenticado/encontrado'}. Razão: ${reason}`);
    });

    // -- Tratamento de Erros --
    socket.on('error', (error) => {
        // Tentar encontrar o email associado para logging
        let errorEmail = null;
         for (let [email, socketInfo] of connectedAndroidApps.entries()) {
            if (socketInfo.socketId === socket.id) {
                errorEmail = email;
                break;
            }
         }
        console.error(`❌ Erro no Socket ${socket.id} (Email: ${errorEmail || 'N/A'}):`, error);
    });
  });

  // Exportar a nova função para encontrar pelo email
  module.exports.getSocketInfoForEmail = getSocketInfoForEmail;
}

// Exporta a função de inicialização E a nova função getSocketInfoForEmail
module.exports = initializeSocketIO;
module.exports.getSocketInfoForEmail = getSocketInfoForEmail; 

// Função auxiliar para obter o email associado a um socketId
function getEmailForSocketId(socketId) {
    for (let [email, info] of connectedAndroidApps.entries()) {
        if (info.socketId === socketId) {
            return email;
        }
    }
    return null;
}

// Função auxiliar para obter o userId a partir do socket
function getUserIdFromSocket(socket) {
    // A informação de autenticação pode vir de diferentes lugares:
    // 1. Diretamente do objeto socket.user (se middleware auth estiver a funcionar corretamente)
    // 2. Do objeto socket.userData (dependendo de como a autenticação está implementada)
    // 3. Do handshake.query.userId (enviado pelo frontend web)
    
    // Verificar todas as possíveis localizações
    if (socket.user && socket.user.id) {
        console.log(`[Socket Auth] Obtendo ID do user de socket.user: ${socket.user.id}`);
        return socket.user.id;
    }
    
    if (socket.userData && socket.userData.id) {
        console.log(`[Socket Auth] Obtendo ID do user de socket.userData: ${socket.userData.id}`);
        return socket.userData.id;
    }
    
    // Se estiver no handshake.query (URL params)
    if (socket.handshake.query && socket.handshake.query.userId) {
        const userId = parseInt(socket.handshake.query.userId, 10);
        console.log(`[Socket Auth] Obtendo ID do user de query params: ${userId}`);
        return userId;
    }
    
    // SOLUÇÃO TEMPORÁRIA: Usar o ID 3 para debugging e testes
    console.log('[Socket Debug] Usando ID fixo (3) porque não encontramos ID no socket:', socket.id);
    return 3; // ID fixo para teste
}

// Função para obter o email de um usuário pelo userId
async function getUserEmailById(userId) {
    try {
        const result = await query('SELECT email FROM users WHERE id = $1', [userId]);
        return result.rows[0]?.email;
    } catch (err) {
        console.error('Erro ao buscar email do usuário:', err);
        return null;
    }
} 