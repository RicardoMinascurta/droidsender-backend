const { query } = require('../config/database');

// Controlador para registar um novo dispositivo (ou atualizar um existente)
const registerDevice = async (req, res) => {
  const userId = req.user.id; // Obtido do utilizador autenticado pelo middleware
  const { deviceId, deviceName, deviceModel } = req.body;

  // Validação básica de entrada
  if (!deviceId) {
    return res.status(400).json({ message: 'O campo deviceId é obrigatório.' });
  }

  try {
    // Tenta inserir o dispositivo. Se já existir uma combinação de user_id e device_id,
    // atualiza os dados e o last_seen.
    const result = await query(
      `INSERT INTO devices (user_id, device_id, device_name, device_model, last_seen, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (user_id, device_id) 
       DO UPDATE SET 
         device_name = EXCLUDED.device_name,
         device_model = EXCLUDED.device_model,
         is_active = true, -- Reativa se estava inativo
         last_seen = NOW(),
         updated_at = NOW()
       RETURNING *`, // Retorna os dados do dispositivo inserido ou atualizado
      [userId, deviceId, deviceName, deviceModel]
    );

    const registeredDevice = result.rows[0];
    console.log(`[Device Ctrl] Dispositivo registado/atualizado para user ${userId}:`, registeredDevice);
    res.status(201).json(registeredDevice); // 201 Created (ou 200 OK se atualizou)

  } catch (error) {
    console.error('Erro ao registar dispositivo:', error);
    // Verificar erro específico de violação de constraint (embora ON CONFLICT deva tratar)
    if (error.code === '23503') { // Foreign key violation (user_id não existe? Improvável aqui)
        return res.status(400).json({ message: 'Utilizador inválido.' });
    }
    res.status(500).json({ message: 'Erro interno do servidor ao registar dispositivo.' });
  }
};

// Controlador para listar os dispositivos do utilizador autenticado
const listDevices = async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await query(
      'SELECT id, device_id, device_name, device_model, is_active, last_seen, created_at, updated_at FROM devices WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );

    res.json(result.rows);

  } catch (error) {
    console.error('Erro ao listar dispositivos:', error);
    res.status(500).json({ message: 'Erro interno do servidor ao listar dispositivos.' });
  }
};

// Controlador para apagar um dispositivo
const deleteDevice = async (req, res) => {
  const userId = req.user.id;
  const deviceDbId = req.params.deviceId; // Nota: este é o ID da BD (PK), não o device_id da app

  if (isNaN(parseInt(deviceDbId, 10))) {
      return res.status(400).json({ message: 'ID de dispositivo inválido.'});
  }

  try {
    const result = await query(
      'DELETE FROM devices WHERE id = $1 AND user_id = $2 RETURNING id', // Só apaga se pertencer ao user
      [deviceDbId, userId]
    );

    if (result.rowCount === 0) {
      // Não apagou nada, ou porque não existe ou porque não pertence ao utilizador
      return res.status(404).json({ message: 'Dispositivo não encontrado ou acesso não autorizado.' });
    }

    console.log(`[Device Ctrl] Dispositivo ${deviceDbId} apagado para user ${userId}`);
    res.status(200).json({ message: 'Dispositivo apagado com sucesso.' }); // Ou 204 No Content

  } catch (error) {
    console.error('Erro ao apagar dispositivo:', error);
    res.status(500).json({ message: 'Erro interno do servidor ao apagar dispositivo.' });
  }
};

// TODO: Adicionar controladores para atualizar estado do dispositivo (online, bateria, etc.) via WebSockets?

module.exports = {
  registerDevice,
  listDevices,
  deleteDevice,
}; 