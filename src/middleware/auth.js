// backend/src/middleware/auth.js

/**
 * Middleware para verificar se o utilizador está autenticado
 */
const ensureAuthenticated = (req, res, next) => {
  // Verificar se o utilizador está autenticado
  if (req.isAuthenticated()) {
    return next();
  }
  
  // Se não estiver autenticado, enviar erro 401 Unauthorized
  res.status(401).json({ message: "Não autenticado. Por favor, faça login." });
};

/**
 * Middleware que verifica se o utilizador está autenticado
 * e tem acesso a determinado recurso (verificando por ex. o papel)
 */
const ensureAuthorized = (requiredRole) => (req, res, next) => {
  // Primeiro verificar se está autenticado
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: "Não autenticado. Por favor, faça login." });
  }
  
  // Verificar se tem o papel necessário
  // Nota: adaptar conforme o modelo de dados/autenticação usado
  const userRole = req.user.role || 'user';
  
  if (requiredRole === 'user' || userRole === 'admin' || userRole === requiredRole) {
    return next();
  }
  
  // Se não tem autorização, enviar erro 403 Forbidden
  res.status(403).json({ message: "Acesso proibido. Não tem permissões suficientes." });
};

// Middleware opcional para verificar se o utilizador é administrador (se necessário no futuro)
// function ensureAdmin(req, res, next) {
//   if (req.isAuthenticated() && req.user.role === 'admin') {
//     return next();
//   }
//   res.status(403).json({ message: 'Acesso proibido. Requer privilégios de administrador.' });
// }

module.exports = {
  isAuthenticated: ensureAuthenticated,
  ensureAuthenticated, // Para backward compatibility
  ensureAuthorized
  // ensureAdmin, // Exportar se/quando for implementado
}; 