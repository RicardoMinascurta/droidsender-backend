const passport = require('passport');

/**
 * Middleware para garantir que a requisição está autenticada via JWT.
 * Usa passport.authenticate com a estratégia 'jwt' e session: false.
 * Se autenticado, adiciona o objeto user a req.user e chama next().
 * Se não autenticado, retorna 401 Unauthorized.
 * Em caso de erro no passport, retorna 500 Internal Server Error.
 */
function ensureAuthenticated(req, res, next) {
  passport.authenticate('jwt', { session: false }, (err, user, info) => {
    if (err) {
      console.error("[Auth Middleware] Erro interno na autenticação JWT:", err);
      return res.status(500).json({ message: 'Erro interno do servidor' });
    }
    if (!user) {
      // info pode conter mensagens como 'No auth token', 'jwt expired', 'jwt malformed', etc.
      const reason = info instanceof Error ? info.message : (info ? String(info) : 'Token inválido ou utilizador não encontrado');
      console.warn(`[Auth Middleware] Falha na autenticação JWT: ${reason}`);
      return res.status(401).json({ message: `Não autorizado: ${reason}` });
    }
    // Autenticação bem-sucedida, anexa o user ao request
    console.log(`[Auth Middleware] Utilizador ${user.email} (ID: ${user.id}) autenticado com sucesso via JWT.`);
    req.user = user;
    return next();
  })(req, res, next); // Não esquecer de invocar a função retornada por authenticate!
}

module.exports = { ensureAuthenticated }; 