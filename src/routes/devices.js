const express = require('express');
const deviceController = require('../controllers/deviceController');
const { ensureAuthenticated } = require('../middleware/auth');

const router = express.Router();

// Todas as rotas de dispositivos requerem autenticação
router.use(ensureAuthenticated);

// Rota POST /api/devices - Registar/Atualizar um dispositivo
router.post('/', deviceController.registerDevice);

// Rota GET /api/devices - Listar dispositivos do utilizador
router.get('/', deviceController.listDevices);

// Rota DELETE /api/devices/:deviceId - Apagar um dispositivo específico
// :deviceId aqui refere-se ao ID da tabela 'devices' (PK), não ao device_id da app
router.delete('/:deviceId', deviceController.deleteDevice);

module.exports = router; 