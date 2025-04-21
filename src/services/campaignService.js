const { query, pool } = require('../config/database');
const { getSocketInfoForEmail } = require('../sockets');

// Função para iniciar o envio de uma campanha
async function startCampaign(campaignId, userId, io) {
  console.log(`[Camp Service] Iniciando/Reiniciando campanha ${campaignId} para user ${userId}...`);
  const client = await pool.connect();

  try {
    // INÍCIO: Primeira Transação apenas para marcar como 'sending'
    await client.query('BEGIN');

    // 1. Busca a campanha e verifica o status e ownership
    const campRes = await client.query(
      'SELECT u.email, c.* FROM campaigns c JOIN users u ON c.user_id = u.id WHERE c.id = $1 AND c.user_id = $2',
      [campaignId, userId]
    );
    const campaign = campRes.rows[0];

    if (!campaign) {
      throw new Error('Campanha não encontrada ou acesso não autorizado.');
    }
    const userEmail = campaign.email;
    if (!userEmail) {
        throw new Error('Não foi possível obter o email do utilizador para a campanha.');
    }

    // 2. Verificar se o status permite iniciar/reiniciar
    // Permitir iniciar se for draft, pending, ou failed.
    // Impedir se já estiver sending ou completed.
    if (campaign.status === 'sending') {
        throw new Error(`Campanha ${campaignId} já está em envio.`);
    }
    if (campaign.status === 'completed') {
         throw new Error(`Campanha ${campaignId} já está concluída.`);
    }

    // 3. Resetar se estiver a reiniciar uma campanha falhada
    if (campaign.status === 'failed') {
        console.log(`[Camp Service] Reiniciando campanha ${campaignId} (status=failed). Resetando destinatários e contadores.`);
        // Resetar status dos destinatários para pending
        await client.query(
            `UPDATE recipients SET status = 'pending', error_message = NULL, sent_at = NULL, updated_at = NOW() 
             WHERE campaign_id = $1`,
            [campaignId]
        );
        // Resetar contadores da campanha
        await client.query(
            `UPDATE campaigns SET recipients_processed = 0, success_count = 0, failure_count = 0, 
             status = 'pending', started_at = NULL, completed_at = NULL, updated_at = NOW() 
             WHERE id = $1`,
            [campaignId]
        );
        // Status agora é 'pending' para continuar o fluxo normal
        campaign.status = 'pending'; 
    }

    // 4. Busca os destinatários PENDENTES (agora inclui os resetados)
    const recipRes = await client.query(
      "SELECT id, phone_number, variables FROM recipients WHERE campaign_id = $1 AND status = 'pending' ORDER BY id ASC", 
      [campaignId]
    );
    const recipients = recipRes.rows;

    if (recipients.length === 0) {
       // Isto não deve acontecer se resetámos 'failed', mas é uma salvaguarda
       await client.query(
           'UPDATE campaigns SET status = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2',
           ['completed', campaignId]
        );
       await client.query('COMMIT');
       console.log(`[Camp Service] Campanha ${campaignId} não tem destinatários pendentes após verificação/reset. Marcada como concluída.`);
       return { message: 'Nenhum destinatário pendente para enviar.' };
    }

    // 5. Encontrar o socket conectado usando o EMAIL do utilizador
    console.log(`[Camp Service] Procurando socket conectado para o email: ${userEmail}`);
    const targetSocketInfo = getSocketInfoForEmail(userEmail);

    if (!targetSocketInfo || !targetSocketInfo.socketId) {
        throw new Error(`Nenhum dispositivo Android conectado encontrado para o email ${userEmail}. Não é possível iniciar a campanha.`);
    }
    const targetSocketId = targetSocketInfo.socketId;
    const targetDeviceId = targetSocketInfo.deviceId;
    console.log(`[Camp Service] Encontrado socket ${targetSocketId} (Device: ${targetDeviceId || 'N/A'}) para o email ${userEmail}.`);

    // Marcar a campanha como 'sending' e INICIAR started_at
    await client.query(
      'UPDATE campaigns SET status = $1, started_at = NOW(), updated_at = NOW() WHERE id = $2',
      ['sending', campaignId]
    );
    console.log(`[Camp Service] Campanha ${campaignId} marcada como 'sending'.`);
    
    // *** COMMIT IMEDIATO DA MUDANÇA DE STATUS ***
    await client.query('COMMIT'); 
    console.log(`[Camp Service] COMMIT da alteração de status para 'sending' efetuado.`);

    // Emitir evento para frontend (requer user_id para a sala)
    if (userId) {
        io.to(`user_${userId}`).emit('campaignStatusUpdate', {
            campaignId: campaignId,
            status: 'sending'
        });
        console.log(`%c[Socket Emit -> Dashboard] ENVIANDO 'campaignStatusUpdate' (sending) PARA user_${userId} VIA startCampaign`, 'color: white; background-color: #17a2b8;', { campaignId: campaignId, status: 'sending' });
        
        // Emitir também o estado inicial da campanha ativa
        const initialActiveCampaign = {
            id: campaignId,
            name: campaign.name, 
            status: 'sending',
            started_at: new Date().toISOString(), // Usar data atual como aproximação
            success_count: 0,
            failure_count: 0,
            recipients_total: recipients.length 
        };
        console.log(`%c[Socket Emit -> Dashboard] ENVIANDO 'activeCampaignUpdate' (initial) PARA user_${userId} VIA startCampaign`, 'color: white; background-color: #007bff;', initialActiveCampaign);
        io.to(`user_${userId}`).emit('activeCampaignUpdate', initialActiveCampaign);
    }

    // INÍCIO: Loop de envio (pode ser sem transação ou com transações por recipient)
    let sentCount = 0;
    const delayBetweenMessages = 2500; // 5 segundos (era 15000 para diagnóstico)
    console.log(`[Camp Service] Iniciando loop de envio para ${recipients.length} mensagens para ${userEmail} (socket ${targetSocketId}) com delay de ${delayBetweenMessages}ms`);

    for (const recipient of recipients) {
      // Colocar cada envio e atualização de contagem numa pequena transação ou executar individualmente
      // (Execução individual é mais simples, mas menos atómica)
      try {
        // Substituir variáveis
        let messageToSend = campaign.message_template;
        if (recipient.variables) {
            for (const key in recipient.variables) {
                // Regex simples para substituir {variavel}
                const regex = new RegExp(`{${key}}`, 'gi');
                messageToSend = messageToSend.replace(regex, recipient.variables[key]);
            }
        }
        
        // TODO: Lidar com variáveis não encontradas?

        const commandPayload = {
          recipientId: recipient.id, // ID do destinatário na DB
          phoneNumber: recipient.phone_number,
          message: messageToSend,
        };

        // Emitir comando para o socket
        io.to(targetSocketId).emit('sendSmsCommand', commandPayload);
        console.log(`[Camp Service] Comando enviado para recipient ${recipient.id} (${recipient.phone_number}) via socket ${targetSocketId}`);

        // Atualizar status do destinatário e contadores (sem transação principal)
        await client.query(
            'UPDATE recipients SET status = $1, sent_at = NOW(), updated_at = NOW() WHERE id = $2',
            ['sent', recipient.id]
        );
        await client.query(
            'UPDATE campaigns SET success_count = success_count + 1, recipients_processed = recipients_processed + 1, updated_at = NOW() WHERE id = $1',
            [campaignId]
        );
        sentCount++;

        // Obter contagens atualizadas para enviar ao frontend
        const countsResult = await client.query(
            'SELECT name, success_count, failure_count, recipients_total FROM campaigns WHERE id = $1',
            [campaignId]
        );
        
        if (countsResult.rowCount > 0) {
            const counts = countsResult.rows[0];
            const progressData = {
                campaignId: campaignId,
                campaignName: campaign.name, 
                recipientId: recipient.id,
                status: 'sent',
                successCount: Number(counts.success_count) || 0,
                failureCount: Number(counts.failure_count) || 0,
                totalRecipients: Number(counts.recipients_total) || 0,
                percentComplete: calculatePercent(counts.success_count, counts.failure_count, counts.recipients_total)
            };
            // Log e Emit campaignProgress
            console.log(`%c[Socket Emit -> Dashboard] ENVIANDO 'campaignProgress' PARA user_${userId} VIA startCampaign (loop)`, 'color: black; background-color: #ffc107;', progressData);
            io.to(`user_${userId}`).emit('campaignProgress', progressData);
        }

        // Esperar antes de enviar o próximo
        if (sentCount < recipients.length) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenMessages));
        }
      } catch (loopError) {
          console.error(`[Camp Service] Erro DENTRO do loop de envio para recipient ${recipient?.id}:`, loopError);
          // Marcar este recipient como falhado?
          if (recipient?.id) {
              await client.query(
                  'UPDATE recipients SET status = $1, error_message = $2, updated_at = NOW() WHERE id = $3',
                  ['failed', loopError.message || 'Erro no loop', recipient.id]
              ).catch(err => console.error('Erro ao marcar recipient como failed no loop:', err));
              // Atualizar contador de falha da campanha?
               await client.query(
                  'UPDATE campaigns SET failure_count = failure_count + 1, recipients_processed = recipients_processed + 1, updated_at = NOW() WHERE id = $1',
                  [campaignId]
              ).catch(err => console.error('Erro ao incrementar failure_count no loop:', err));
          }
          // Considerar se deve continuar o loop ou abortar a campanha
      }
    }
    
    // Após o loop, verificar se precisa marcar como 'completed' (esta lógica pode precisar de ajuste)
    // A conclusão agora deveria depender mais dos eventos `smsStatusUpdate`
    console.log(`[Camp Service] Loop de envio para ${campaignId} concluído. ${sentCount} comandos enviados.`);
    // Talvez remover a marcação automática de completed daqui e confiar no smsStatusUpdate?
    /* 
    const finalCounts = await client.query(...); // Buscar contagens finais
    if (finalCounts.recipients_processed >= finalCounts.recipients_total) {
       await client.query('UPDATE campaigns SET status = $1 WHERE id = $2 AND status = $3', ['completed', campaignId, 'sending']);
       // Emitir evento
    }
    */
   
    // Retorno de sucesso indica que o processo de envio foi iniciado/percorrido
    return { message: `${sentCount} comandos de SMS enviados. Verifique o status final.` };

  } catch (error) {
    // Se o erro ocorreu ANTES do commit inicial (ex: buscar campanha, verificar socket)
    // O rollback será feito implicitamente ou precisa ser tratado aqui se a conexão ainda existir
    try { await client.query('ROLLBACK'); } catch (rbError) { /* Ignorar erro no rollback */ }
    
    console.error(`[Camp Service] Erro GERAL ao iniciar/processar campanha ${campaignId}:`, error);
    // Tentar marcar como 'failed'
    await pool.query( // Usar pool aqui caso client esteja inválido
        'UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2 AND status != $1', 
        ['failed', campaignId]
    ).catch(err => console.error('Erro ao atualizar status para falha no catch geral:', err));
    // Emitir evento de falha
    if (userId) {
        const failureData = {
            campaignId: campaignId,
            status: 'failed',
            error: error.message
        };
        // Log antes de emitir campaignStatusUpdate (failed)
        console.log(`%c[Socket Emit -> Dashboard] ENVIANDO 'campaignStatusUpdate' (failed) PARA user_${userId} VIA startCampaign (catch)`, 'color: white; background-color: #dc3545;', failureData);
        
        io.to(`user_${userId}`).emit('campaignStatusUpdate', failureData);
    }
    throw error;
  } finally {
    // Libertar o cliente da pool
    client.release();
  }
}

// Helper function para calcular percentagem (pode ser movida para utils)
function calculatePercent(success, failure, total) {
    const s = Number(success) || 0;
    const f = Number(failure) || 0;
    const t = Number(total) || 0;
    if (t === 0) return 0;
    return Math.round(((s + f) / t) * 100);
}

module.exports = {
  startCampaign,
}; 