const jwt = require('jsonwebtoken');

const socketAuthMiddleware = (socket, next) => {
  // O token JWT geralmente é enviado pelo cliente na propriedade 'auth' do handshake
  // Exemplo no cliente (socket.io-client):
  // const socket = io("http://localhost:3000", { auth: { token: "seu_jwt_aqui" } });
  const token = socket.handshake.auth?.token; 

  if (!token) {
    console.warn(`[Socket Auth] Conexão recusada: Nenhum token fornecido (Socket ID: ${socket.id})`);
    // Retorna um erro para o cliente
    return next(new Error('Autenticação falhou: Token não fornecido.'));
  }

  try {
    // Verifica o token usando o mesmo segredo usado para criá-lo
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Se o token for válido, 'decoded' conterá o payload (id, email, etc.)
    // Anexa os dados decodificados ao objeto socket para uso posterior nos handlers de eventos
    socket.userData = decoded; 
    console.log(`[Socket Auth] Token válido. Utilizador autenticado: ${decoded.email} (Socket ID: ${socket.id})`);
    
    // Chama next() sem erro para permitir a conexão
    next();

  } catch (err) {
    // Se o token for inválido (expirado, assinatura incorreta, etc.)
    console.warn(`[Socket Auth] Conexão recusada: Token inválido (Socket ID: ${socket.id}). Erro: ${err.message}`);
    return next(new Error('Autenticação falhou: Token inválido ou expirado.'));
  }
};

module.exports = socketAuthMiddleware; 