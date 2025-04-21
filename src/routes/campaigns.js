const express = require('express');
const campaignController = require('../controllers/campaignController');
const authMiddleware = require('../middleware/auth');
const upload = require('../middleware/upload'); // Para upload de ficheiros

const router = express.Router();

// Aplicar middleware de autenticação em todas as rotas
router.use(authMiddleware.ensureAuthenticated);

// Obter todas as campanhas do utilizador autenticado
router.get('/', campaignController.listCampaigns);

// Obter campanha ativa (em execução)
router.get('/active', campaignController.getActiveCampaign);

// Obter uma campanha específica por ID
router.get('/:campaignId', campaignController.getCampaignDetails);

// Criar nova campanha
router.post('/', upload.single('file'), campaignController.createCampaign);

// Listar destinatários de uma campanha
router.get('/:campaignId/recipients', campaignController.listRecipientsForCampaign);

// Iniciar o envio de uma campanha
router.post('/:campaignId/start', campaignController.startCampaignSending);

// Apagar uma campanha
router.delete('/:campaignId', campaignController.deleteCampaign);

// TODO: Adicionar rotas para PUT (atualizar), PATCH (pausar/retomar)

module.exports = router; 