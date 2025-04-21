const express = require('express');
const userController = require('../controllers/userController');
const { ensureAuthenticated } = require('../middleware/authMiddleware'); // Importa o middleware

const router = express.Router();

// Rota GET /api/users/me
// Protegida: Só utilizadores autenticados podem aceder
router.get('/me', ensureAuthenticated, userController.getMe);

// TODO: Adicionar outras rotas de utilizador aqui (ex: PUT /me para atualizar)

module.exports = router; 