// backend/src/routes/auth.js
const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const authController = require('../controllers/authController');
const { ensureAuthenticated } = require('../middleware/authMiddleware');

const router = express.Router();

// Rota para iniciar o fluxo de autenticação Google
// Redireciona o utilizador para a página de login do Google
router.get('/google', 
  passport.authenticate('google', { 
    scope: ['profile', 'email'] // Pedimos acesso ao perfil e email
  })
);

// Rota de callback que o Google chama após o utilizador fazer login
router.get('/google/callback', 
  passport.authenticate('google', { 
    failureMessage: true,
    // Redirecionar para o frontend mesmo em caso de falha (o frontend trata)
    // Idealmente, uma rota específica de falha no frontend
    failureRedirect: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?error=google_auth_failed` 
  }),
  (req, res) => {
    // Autenticação bem-sucedida! req.user está disponível.
    console.log('[Auth Callback] Autenticação Google bem-sucedida para:', req.user?.email);

    // 1. Criar o payload do JWT
    const payload = {
      id: req.user.id,
      email: req.user.email
      // Pode adicionar mais informações não sensíveis se necessário (ex: roles)
    };

    // 2. Gerar o token JWT
    try {
      const token = jwt.sign(
        payload, 
        process.env.JWT_SECRET, 
        { expiresIn: '1d' } // Define a validade do token (ex: 1 dia)
      );

      // 3. Redirecionar para o frontend com o token como query parameter
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const redirectUrl = `${frontendUrl}/auth/success?token=${encodeURIComponent(token)}`;
      console.log(`[Auth Callback] Redirecionando para: ${redirectUrl}`);
      res.redirect(redirectUrl);

    } catch (error) {
        console.error('[Auth Callback] Erro ao gerar token JWT:', error);
        // Redirecionar para uma página de erro no frontend
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        res.redirect(`${frontendUrl}/login?error=token_generation_failed`);
    }
  }
);

// Rota para fazer logout
router.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) { return next(err); } // Encaminha erro, se houver
    req.session.destroy((err) => { // Destruir a sessão explicitamente
        if (err) {
            console.error('[Logout] Erro ao destruir sessão:', err);
            // Mesmo com erro, tentar limpar o cookie e redirecionar
        }
        res.clearCookie('connect.sid'); // Limpar o cookie da sessão
        console.log('[Logout] Sessão terminada com sucesso.');
        // Redirecionar para a página de login ou home do frontend
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
        res.redirect(`${frontendUrl}/login`); // Ou para '/' se preferir a home
    });
  });
});

// Rota opcional para verificar o estado da autenticação (útil para o frontend)
router.get('/status', (req, res) => {
  if (req.isAuthenticated()) {
    // Utilizador está autenticado, envia dados mínimos
    res.json({ 
      isAuthenticated: true, 
      user: { 
        id: req.user.id, 
        email: req.user.email, 
        subscription_plan: req.user.subscription_plan
        // Não envie dados sensíveis como google_id ou hashes
      } 
    });
  } else {
    // Utilizador não está autenticado
    res.json({ isAuthenticated: false, user: null });
  }
});

// Rota chamada pelo frontend após o callback do Google (Web)
router.get('/login/success', authController.loginSuccess);

// Rota de falha (Web)
router.get('/login/failed', authController.loginFailed);

// Rota para logout (Comum a Web e talvez App?)
router.post('/logout', ensureAuthenticated, authController.logout);

// Rota para verificar status da autenticação (Comum)
router.get('/status', ensureAuthenticated, authController.checkStatus);

// *** NOVA ROTA para Android Google Sign-In ***
router.post('/google/android', authController.googleSignInAndroid);

// TODO: Criar uma rota para redirecionamento em caso de falha no login
// router.get('/login-failed', (req, res) => { ... });

// Rota para obter perfil do utilizador (protegida por JWT)
router.get('/profile', passport.authenticate('jwt', { session: false }), (req, res) => {
  // req.user contém os dados do utilizador do payload do JWT
  res.json({ user: req.user });
});

module.exports = router; 