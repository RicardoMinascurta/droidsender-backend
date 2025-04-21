// backend/src/sockets/index.js
const { query, pool } = require('../config/database'); // <-- ADICIONAR pool AQUI

// Novo Mapa para guardar: email -> { socketId, deviceId }
const connectedAndroidApps = new Map(); 

// Nova função para encontrar informações do socket pelo email
function getSocketInfoForEmail(targetEmail) {
  return connectedAndroidApps.get(targetEmail); // Retorna { socketId, deviceId } ou undefined
}

// Helper para buscar dispositivos ativos de um user
async function getActiveDevicesForUser(userId) {
  try {
    const result = await query(
      'SELECT id, device_id, device_name, device_model, is_active, last_seen, battery_level FROM devices WHERE user_id = $1 AND is_active = true ORDER BY last_seen DESC NULLS LAST, created_at DESC',
      [userId]
    );
    return result.rows;
  } catch (error) {
    console.error(`[DB Error] Failed to get active devices for user ${userId}:`, error);
    return []; // Retorna array vazio em caso de erro
  }
}

function initializeSocketIO(io) {
  console.log('🔌 Inicializando Socket.IO (com autenticação por email via evento)...');

  // *** MIDDLEWARE DE AUTENTICAÇÃO SOCKET (Opcional mas Recomendado) ***
  // io.use(socketAuthMiddleware); // Implementar se quiser autenticar via token na conexão inicial

  io.on('connection', (socket) => {
    console.log(`⚡ Cliente conectado (Socket ID: ${socket.id}) - Aguardando autenticação...`);

    // Evento para o frontend entrar na sua sala após autenticar
    socket.on('joinUserRoom', () => {
       // Se usarmos middleware de autenticação, o ID estará em socket.userId
       const userId = socket.userId;
       if (userId) {
           const roomName = `user_${userId}`;
           socket.join(roomName);
           console.log(`[Socket Room] Socket ${socket.id} (UserID: ${userId}) entrou na sala ${roomName}`);
       } else {
           console.warn(`[Socket Room] Tentativa de joinUserRoom por socket ${socket.id} sem UserID associado.`);
       }
    });

    // --- Listener para Autenticação da App Android (CORRIGIDO) ---
    socket.on('authenticate_android', async (data) => {
      const deviceId = data?.deviceId;
      const email = data?.email;

      if (!deviceId || !email) {
        console.warn(`[Socket ${socket.id}] Evento 'authenticate_android' recebido sem deviceId ou email.`, data);
        socket.emit('registrationError', { message: 'deviceId e email são obrigatórios.' });
        return;
      }

      let client;
      try {
        client = await pool.connect(); // Obter cliente da pool

        // 1. Buscar o user_id pelo email
        const userResult = await client.query('SELECT id FROM users WHERE email = $1', [email]);
        if (userResult.rowCount === 0) {
          console.warn(`[Socket Auth] Email ${email} não encontrado na DB para device ${deviceId}.`);
          socket.emit('registrationError', { message: 'Email não registado.' });
          client.release();
          return;
        }
        const userId = userResult.rows[0].id;
        console.log(`[Socket Auth] User encontrado para email ${email}: UserID=${userId}`);

        // 2. Associar userId ao socket para uso futuro
        socket.userId = userId;
        socket.deviceId = deviceId; // Associar deviceId também pode ser útil

        // Verificar se este email/userId já está conectado com outro socket
        // (Adaptar connectedAndroidApps para usar userId como chave seria mais robusto)
        // (Por agora, mantemos a lógica original baseada em email para desconectar o antigo)
        const existingSocketInfo = connectedAndroidApps.get(email);
        if (existingSocketInfo && existingSocketInfo.socketId !== socket.id) {
            console.warn(`[Socket ${socket.id}] Email ${email} já estava associado ao socket ${existingSocketInfo.socketId}. Desconectando socket antigo...`);
            const oldSocket = io.sockets.sockets.get(existingSocketInfo.socketId);
            oldSocket?.disconnect(true);
        }
        connectedAndroidApps.set(email, { socketId: socket.id, deviceId: deviceId, userId: userId }); // Guardar userId também

        // 3. Atualizar/Inserir o dispositivo na DB
        const upsertDeviceQuery = `
          INSERT INTO devices (user_id, device_id, is_active, last_seen, updated_at)
          VALUES ($1, $2, true, NOW(), NOW())
          ON CONFLICT (user_id, device_id)
          DO UPDATE SET
            is_active = true,
            last_seen = NOW(),
            updated_at = NOW();
        `;
        await client.query(upsertDeviceQuery, [userId, deviceId]);
        console.log(`[DB Update] Dispositivo UserID=${userId}, DeviceID=${deviceId} marcado como ativo/atualizado.`);

        client.release(); // Libertar cliente após query DB

        // 4. Emitir sucesso de volta para o Android
        socket.emit('registrationSuccess', { message: 'Dispositivo autenticado e registado com sucesso.' });
        console.log(`📱 App Android autenticada e registada: Email=${email}, DeviceID=${deviceId}, SocketID=${socket.id}, UserID=${userId}`);

        // 5. Emitir atualização de dispositivos para o Frontend
        const activeDevices = await getActiveDevicesForUser(userId);
        const roomName = `user_${userId}`;
        console.log(`[Socket Emit -> ${roomName}] Emitindo 'devices_update' após autenticação android.`, activeDevices);
        io.to(roomName).emit('devices_update', activeDevices);

      } catch (error) {
        console.error(`[Socket Auth Error] Erro ao autenticar/registar dispositivo ${deviceId} para email ${email}:`, error);
        socket.emit('registrationError', { message: 'Erro interno do servidor durante o registo.' });
        if (client) client.release(); // Garante que o cliente é libertado em caso de erro
      }
    });

    // -- Eventos de Status da App para o Backend --
    socket.on('smsStatusUpdate', async (data) => {
        // IMPORTANTE: Agora podemos obter userId diretamente do socket!
        const userId = socket.userId;
        const deviceId = socket.deviceId;

        if (!userId) {
            console.warn(`[Socket ${socket.id}] Recebido smsStatusUpdate sem userId associado ao socket. Ignorando.`);
            return;
        }

        const { recipientId, status, errorMessage } = data;
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

    // -- Evento de Status do Dispositivo (CORRIGIDO) --
    socket.on('deviceStatusUpdate', async (data) => {
      const userId = socket.userId;
      const deviceId = socket.deviceId;

      if (!userId || !deviceId) {
        console.warn(`[Socket ${socket.id}] Recebido deviceStatusUpdate sem userId/deviceId associado ao socket. Ignorando.`);
        return;
      }

      const { batteryLevel, smsPackage, deviceModel } = data;
      console.log(`[Socket ${socket.id}] Recebido deviceStatusUpdate de UserID=${userId}, DeviceID=${deviceId}:`, data);

      try {
        // Atualizar apenas os campos relevantes na DB
        const updateQuery = `
          UPDATE devices
          SET battery_level = $1, last_seen = NOW(), device_model = $3, updated_at = NOW()
          WHERE user_id = $4 AND device_id = $5;
        `;
        await query(updateQuery, [batteryLevel, deviceModel, userId, deviceId]); // Removi smsPackage daqui

        // Emitir atualização para o frontend
        const activeDevices = await getActiveDevicesForUser(userId);
        const roomName = `user_${userId}`;
        console.log(`[Socket Emit -> ${roomName}] Emitindo 'devices_update' após status update.`, activeDevices);
        io.to(roomName).emit('devices_update', activeDevices);

      } catch (error) {
        console.error(`[DB Error] Erro ao atualizar status do dispositivo ${deviceId} para user ${userId}:`, error);
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`🔌 Cliente desconectado (Socket ID: ${socket.id}). Razão: ${reason}`);
      const userId = socket.userId; // Tenta obter userId associado
      const deviceId = socket.deviceId;

      // Remover do mapa de conexões Android
      let disconnectedEmail = null;
      for (let [email, socketInfo] of connectedAndroidApps.entries()) {
          if (socketInfo.socketId === socket.id) {
              disconnectedEmail = email;
              connectedAndroidApps.delete(email);
              console.log(`[Socket Disconnect] Removida entrada do mapa para Email=${email}, SocketID=${socket.id}`);
              break;
          }
      }

      // Se conseguimos identificar o user e device, marcar como inativo na DB e notificar frontend
      if (userId && deviceId) {
          (async () => {
              try {
                  console.log(`[Socket Disconnect] Marcando dispositivo UserID=${userId}, DeviceID=${deviceId} como inativo...`);
                  await query('UPDATE devices SET is_active = false, updated_at = NOW() WHERE user_id = $1 AND device_id = $2', [userId, deviceId]);

                  // Emitir atualização para o frontend
                  const activeDevices = await getActiveDevicesForUser(userId);
                  const roomName = `user_${userId}`;
                  console.log(`[Socket Emit -> ${roomName}] Emitindo 'devices_update' após desconexão android.`, activeDevices);
                  io.to(roomName).emit('devices_update', activeDevices);

              } catch (error) {
                  console.error(`[DB Error] Erro ao marcar dispositivo ${deviceId} como inativo para user ${userId}:`, error);
              }
          })();
      } else {
          console.warn(`[Socket Disconnect] Socket ${socket.id} desconectado sem UserID/DeviceID associado.`);
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