const { query, pool } = require('../config/database');
const xlsx = require('xlsx');
const campaignService = require('../services/campaignService');

// Controlador para criar uma nova campanha E processar o ficheiro
const createCampaign = async (req, res) => {
  const userId = req.user.id;
  // Obter dados do corpo (multer preenche para ficheiro)
  const { name, messageTemplate, scheduledAt } = req.body; 
  
  // Validação básica de entrada
  if (!name || !messageTemplate) {
    return res.status(400).json({ message: 'Os campos name e messageTemplate são obrigatórios.' });
  }

  // Verificar se o ficheiro foi enviado
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ message: 'Ficheiro Excel de destinatários é obrigatório.' });
  }

  // Validar e processar scheduledAt
  let scheduleTimestamp = null;
  let initialStatus = 'pending'; // Status padrão para envio imediato
  if (scheduledAt) {
      try {
          scheduleTimestamp = new Date(scheduledAt);
          // Verificar se a data é válida e não no passado (margem de segurança)
          if (isNaN(scheduleTimestamp.getTime()) || scheduleTimestamp < new Date(Date.now() - 60000)) { // Permite agendar ~1 min no passado por segurança
              return res.status(400).json({ message: 'Data de agendamento inválida ou no passado.'});
          }
          initialStatus = 'scheduled'; // Mudar status se agendado
          console.log(`[Create Camp] Agendamento detetado para: ${scheduleTimestamp.toISOString()}`);
      } catch (e) {
           return res.status(400).json({ message: 'Formato inválido para data de agendamento.'});
      }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insere a campanha na base de dados com status e scheduled_at corretos
    const campaignInsertQuery = `
      INSERT INTO campaigns 
        (user_id, name, message_template, source_file_name, status, scheduled_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       RETURNING *`;
    const campaignInsertParams = [
        userId, 
        name, 
        messageTemplate, 
        req.file.originalname, 
        initialStatus, // Status dinâmico
        scheduleTimestamp // NULL se não agendado
    ];
    const campaignResult = await client.query(campaignInsertQuery, campaignInsertParams);
    const newCampaign = campaignResult.rows[0];
    const campaignId = newCampaign.id;

    console.log(`[Campaign Ctrl] Campanha ${campaignId} criada com status ${initialStatus}. Processando ficheiro...`);

    // --- Lógica de Processamento do Ficheiro (adaptada de uploadRecipients) ---
    
    // 2. Ler o ficheiro Excel do buffer em memória
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const recipientsData = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

    if (!recipientsData || recipientsData.length < 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Ficheiro Excel vazio ou inválido.' });
    }

    // 3. Processar os dados
    const header = recipientsData[0].map(h => String(h).trim().toLowerCase());
    const phoneIndex = header.indexOf('telefone');

    if (phoneIndex === -1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Coluna \'telefone\' não encontrada no cabeçalho do Excel.' });
    }

    const recipientsToInsert = [];
    for (let i = 1; i < recipientsData.length; i++) {
      const row = recipientsData[i];
      const phoneNumber = row[phoneIndex] ? String(row[phoneIndex]).trim() : null;
      
      if (phoneNumber && phoneNumber.length > 5) { 
        const variables = {};
        header.forEach((colName, index) => {
          if (index !== phoneIndex && row[index] !== undefined && row[index] !== null) {
            variables[colName] = row[index];
          }
        });
        // Usar o campaignId da campanha recém-criada
        recipientsToInsert.push([campaignId, phoneNumber, variables]); 
      } else {
         console.warn(`[Create Camp] Linha ${i+1} do Excel ignorada: número inválido.`);
      }
    }

    if (recipientsToInsert.length === 0) {
        await client.query('ROLLBACK');
        // Poderíamos criar a campanha sem destinatários, mas talvez seja melhor dar erro?
        // Alternativa: Fazer commit da campanha e retornar aviso.
        return res.status(400).json({ message: 'Nenhum destinatário válido encontrado no ficheiro.' });
    }

    // 4. Inserir destinatários na base de dados
    let insertedCount = 0;
    // TODO: Otimizar com bulk insert para performance (usando pg-format ou similar)
    for (const recipient of recipientsToInsert) {
        await client.query(
          'INSERT INTO recipients (campaign_id, phone_number, variables, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())',
          recipient
        );
        insertedCount++;
    }
    console.log(`[Create Camp] ${insertedCount} destinatários inseridos para campanha ${campaignId}.`);

    // 5. Atualizar o contador na campanha
    await client.query(
      'UPDATE campaigns SET recipients_total = $1, updated_at = NOW() WHERE id = $2',
      [insertedCount, campaignId]
    );

    // 6. Commit da transação
    await client.query('COMMIT');

    // Atualizar o objeto newCampaign com a contagem
    newCampaign.recipients_total = insertedCount;

    console.log(`[Create Camp] Campanha ${campaignId} e ${insertedCount} destinatários criados com sucesso.`);
    res.status(201).json(newCampaign);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao criar campanha e processar ficheiro:', error);
    // TODO: Tratar outros erros específicos se necessário (ex: DB constraint)
    res.status(500).json({ message: 'Erro interno do servidor ao criar campanha.' });
  } finally {
    client.release();
  }
};

// Controlador para listar as campanhas do utilizador autenticado
const listCampaigns = async (req, res) => {
  const userId = req.user.id;

  try {
    // Selecionar também scheduled_at
    const result = await query(
      `SELECT id, name, status, recipients_total, recipients_processed, 
              success_count, failure_count, source_file_name, created_at, updated_at,
              message_template, scheduled_at
       FROM campaigns 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json(result.rows);

  } catch (error) {
    console.error('Erro ao listar campanhas:', error);
    res.status(500).json({ message: 'Erro interno do servidor ao listar campanhas.' });
  }
};

// Controlador para obter detalhes de uma campanha específica
const getCampaignDetails = async (req, res) => {
  const userId = req.user.id;
  const campaignId = req.params.campaignId;

   if (isNaN(parseInt(campaignId, 10))) {
      return res.status(400).json({ message: 'ID de campanha inválido.'});
  }

  try {
    // Busca detalhes da campanha
    const campaignResult = await query(
      'SELECT * FROM campaigns WHERE id = $1 AND user_id = $2', // Garante que pertence ao user
      [campaignId, userId]
    );

    if (campaignResult.rowCount === 0) {
      return res.status(404).json({ message: 'Campanha não encontrada ou acesso não autorizado.' });
    }

    const campaign = campaignResult.rows[0];

    // TODO: Opcionalmente, buscar também os destinatários associados a esta campanha
    // const recipientsResult = await query('SELECT phone_number, status, error_message FROM recipients WHERE campaign_id = $1', [campaignId]);
    // campaign.recipients = recipientsResult.rows; // Adicionar ao objeto da campanha

    res.json(campaign);

  } catch (error) {
    console.error('Erro ao obter detalhes da campanha:', error);
    res.status(500).json({ message: 'Erro interno do servidor ao obter detalhes da campanha.' });
  }
};

// Controlador para fazer upload e processar ficheiro de destinatários (Excel)
const uploadRecipients = async (req, res) => {
  const userId = req.user.id;
  const { campaignId } = req.params;

  if (isNaN(parseInt(campaignId, 10))) {
    return res.status(400).json({ message: 'ID de campanha inválido.' });
  }

  if (!req.file) {
    return res.status(400).json({ message: 'Nenhum ficheiro enviado.' });
  }

  // Usar uma transação para garantir atomicidade (ou tudo ou nada)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verificar se a campanha existe e pertence ao utilizador
    const campaignCheck = await client.query(
      'SELECT id FROM campaigns WHERE id = $1 AND user_id = $2', 
      [campaignId, userId]
    );
    if (campaignCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Campanha não encontrada ou acesso não autorizado.' });
    }

    // 2. Ler o ficheiro Excel do buffer em memória
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0]; // Assume a primeira folha
    const worksheet = workbook.Sheets[sheetName];
    const recipientsData = xlsx.utils.sheet_to_json(worksheet, { header: 1 }); // Converte para array de arrays

    if (!recipientsData || recipientsData.length < 2) { // Pelo menos cabeçalho e uma linha de dados
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Ficheiro Excel vazio ou inválido (sem dados após cabeçalho).' });
    }

    // 3. Processar os dados
    const header = recipientsData[0].map(h => String(h).trim().toLowerCase()); // Cabeçalho em minúsculas
    const phoneIndex = header.indexOf('telefone'); // Procura coluna 'telefone'
    // TODO: Adicionar mais flexibilidade para nomes de coluna (ex: 'phone', 'mobile', 'número')

    if (phoneIndex === -1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Coluna \'telefone\' não encontrada no cabeçalho do ficheiro Excel.' });
    }

    let insertedCount = 0;
    const recipientsToInsert = [];
    for (let i = 1; i < recipientsData.length; i++) {
      const row = recipientsData[i];
      const phoneNumber = row[phoneIndex] ? String(row[phoneIndex]).trim() : null;
      
      // Simples validação/limpeza do número (pode ser melhorada)
      if (phoneNumber && phoneNumber.length > 5) { // Exemplo: ignora números muito curtos
        const variables = {};
        header.forEach((colName, index) => {
          if (index !== phoneIndex && row[index] !== undefined && row[index] !== null) {
            variables[colName] = row[index]; // Guarda outras colunas como variáveis JSON
          }
        });
        recipientsToInsert.push([campaignId, phoneNumber, variables]);
      } else {
         console.warn(`[Upload Rec] Linha ${i+1} ignorada: número de telefone inválido ou em falta.`);
      }
    }

    if (recipientsToInsert.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Nenhum destinatário válido encontrado no ficheiro.' });
    }

    // 4. Inserir destinatários na base de dados (Bulk Insert pode ser mais eficiente para muitos registos)
    // Por simplicidade, vamos inserir um por um dentro da transação
    // Alternativa: usar pg-format para bulk insert
    for (const recipient of recipientsToInsert) {
        await client.query(
          'INSERT INTO recipients (campaign_id, phone_number, variables, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())',
          recipient
        );
        insertedCount++;
    }

    // 5. Atualizar o contador na campanha
    await client.query(
      'UPDATE campaigns SET recipients_total = $1, updated_at = NOW() WHERE id = $2',
      [insertedCount, campaignId]
    );

    // 6. Commit da transação
    await client.query('COMMIT');

    console.log(`[Upload Rec] ${insertedCount} destinatários importados para campanha ${campaignId}`);
    res.json({ 
      message: `${insertedCount} destinatários importados com sucesso.`,
      count: insertedCount
    });

  } catch (error) {
    await client.query('ROLLBACK'); // Garante rollback em caso de erro
    console.error(`Erro ao processar upload para campanha ${campaignId}:`, error);
    res.status(500).json({ message: 'Erro interno do servidor ao processar ficheiro.' });
  } finally {
    client.release(); // Liberta a conexão de volta para o pool
  }
};

// Controlador para iniciar o envio de uma campanha
const startCampaignSending = async (req, res) => {
  const userId = req.user.id;
  const { campaignId } = req.params;
  // Obter a instância io a partir da app Express
  const ioInstance = req.app.get('io'); 

  if (isNaN(parseInt(campaignId, 10))) {
    return res.status(400).json({ message: 'ID de campanha inválido.'});
  }

  try {
    // Passar a instância io real para o serviço
    const result = await campaignService.startCampaign(campaignId, userId, ioInstance); 

    res.status(200).json(result);
  } catch (error) {
    console.error(`Erro no controlador ao iniciar campanha ${campaignId}:`, error.message);
    // Evitar expor detalhes internos do erro
    if (error.message.includes('não encontrada') || error.message.includes('não autorizado')) {
        return res.status(404).json({ message: error.message });
    }
    if (error.message.includes('Nenhum dispositivo ativo') || error.message.includes('não está conectado')) {
        return res.status(409).json({ message: error.message }); // 409 Conflict - pré-condição falhou
    }
     if (error.message.includes('já está')) {
        return res.status(409).json({ message: error.message });
    }
    // Erro genérico
    res.status(500).json({ message: 'Erro interno ao iniciar a campanha.' });
  }
};

// Controlador para listar os destinatários de uma campanha específica
const listRecipientsForCampaign = async (req, res) => {
  const userId = req.user.id;
  const { campaignId } = req.params;

  if (isNaN(parseInt(campaignId, 10))) {
      return res.status(400).json({ message: 'ID de campanha inválido.'});
  }

  try {
    // Verificar primeiro se a campanha pertence ao utilizador (boa prática)
    const campaignCheck = await query(
      'SELECT id FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, userId]
    );
    if (campaignCheck.rowCount === 0) {
      return res.status(404).json({ message: 'Campanha não encontrada ou acesso não autorizado.' });
    }

    // Buscar os destinatários para essa campanha
    const result = await query(
      'SELECT id, phone_number, status, error_message, variables, created_at, updated_at \n' + 
      'FROM recipients \n' +
      'WHERE campaign_id = $1 \n' + 
      'ORDER BY id ASC', // Ou outra ordenação desejada
      [campaignId]
    );

    res.json(result.rows);

  } catch (error) {
    console.error(`Erro ao listar destinatários para campanha ${campaignId}:`, error);
    res.status(500).json({ message: 'Erro interno do servidor ao listar destinatários.' });
  }
};

// Controlador para apagar uma campanha
const deleteCampaign = async (req, res) => {
  const userId = req.user.id;
  const { campaignId } = req.params;

  console.log(`[Campaign Ctrl] Tentando apagar campanha ${campaignId} para user ${userId}...`);

  try {
    // Tenta apagar a campanha verificando o ownership
    // Nota: Assume ON DELETE CASCADE na DB para apagar recipients.
    // Se não houver CASCADE, seria necessária uma transação para apagar recipients primeiro.
    const result = await query(
      'DELETE FROM campaigns WHERE id = $1 AND user_id = $2',
      [campaignId, userId]
    );

    // Verifica se alguma linha foi apagada
    if (result.rowCount === 0) {
      // Se 0 linhas foram afetadas, a campanha não foi encontrada ou não pertencia ao utilizador
      console.warn(`[Campaign Ctrl] Campanha ${campaignId} não encontrada para apagar ou acesso não autorizado para user ${userId}.`);
      return res.status(404).json({ message: 'Campanha não encontrada ou acesso não autorizado.' });
    }

    // Sucesso
    console.log(`[Campaign Ctrl] Campanha ${campaignId} apagada com sucesso para user ${userId}.`);
    res.status(204).send(); // 204 No Content é a resposta padrão para DELETE bem-sucedido

  } catch (error) {
    console.error(`Erro ao apagar campanha ${campaignId}:`, error);
    // TODO: Tratar erros específicos (ex: DB error)
    res.status(500).json({ message: 'Erro interno do servidor ao apagar campanha.' });
  }
};

/**
 * Obtém a campanha ativa (em estado "sending") do utilizador autenticado
 */
const getActiveCampaign = async (req, res) => {
  const userId = req.user.id;
  
  try {
    // Busca apenas campanhas em estado "sending" deste utilizador
    const result = await pool.query(
      `SELECT c.*, COUNT(r.id) as recipients_total,
        SUM(CASE WHEN r.status = 'delivered' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN r.status IN ('failed', 'delivery_failed') THEN 1 ELSE 0 END) as failure_count
      FROM campaigns c
      LEFT JOIN recipients r ON c.id = r.campaign_id
      WHERE c.user_id = $1 AND c.status = 'sending'
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT 1`,
      [userId]
    );
    
    if (result.rows.length === 0) {
      // Nenhuma campanha ativa encontrada, retornar null
      return res.json(null);
    }
    
    // Retornar a campanha ativa com as contagens
    res.json(result.rows[0]);
  } catch (error) {
    console.error(`[API] Erro ao buscar campanha ativa: ${error.message}`);
    res.status(500).json({ message: 'Erro interno ao buscar campanha ativa' });
  }
};

// TODO: Adicionar controladores para atualizar, pausar, retomar, eliminar campanhas

module.exports = {
  createCampaign,
  listCampaigns,
  getCampaignDetails,
  uploadRecipients,
  startCampaignSending,
  listRecipientsForCampaign,
  deleteCampaign,
  getActiveCampaign
}; 