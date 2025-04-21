const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { query } = require('../config/database'); // Assumindo que tens a config da DB
require('dotenv').config(); // Para carregar variáveis de ambiente

// Instanciar o cliente OAuth2 com o Client ID (o mesmo usado na App Android)
// Garante que tens GOOGLE_CLIENT_ID no teu .env
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ... (funções existentes: googleCallback, loginSuccess, loginFailed, logout, checkStatus) ...

const googleCallback = (req, res) => { /* ... */ };
const loginSuccess = (req, res) => { /* ... */ };
const loginFailed = (req, res) => { /* ... */ };
const logout = (req, res) => { /* ... */ };
const checkStatus = (req, res) => { /* ... */ };


// *** NOVA FUNÇÃO para Android Google Sign-In ***
const googleSignInAndroid = async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ message: 'ID Token do Google não fornecido.' });
  }

  try {
    // 1. Verificar o ID Token com o Google
    const ticket = await client.verifyIdToken({
        idToken: idToken,
        audience: process.env.GOOGLE_CLIENT_ID, // Especifica o CLIENT_ID esperado
    });
    const payload = ticket.getPayload();
    const googleId = payload['sub'];
    const email = payload['email'];
    const name = payload['name'];
    const picture = payload['picture']; // URL da imagem de perfil

    // 2. Encontrar ou Criar Utilizador na DB (lógica similar ao callback do Passport)
    let userResult = await query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    let user;

    if (userResult.rows.length > 0) {
      // Utilizador encontrado, atualizar dados se necessário (ex: nome, foto)
      user = userResult.rows[0];
      console.log(`[Auth Android] Utilizador encontrado: ${user.email}`);
      // Opcional: Atualizar nome/foto se mudaram
      if (user.name !== name || user.profile_picture !== picture) {
          await query(
              'UPDATE users SET name = $1, profile_picture = $2, updated_at = NOW() WHERE id = $3',
              [name, picture, user.id]
          );
          console.log(`[Auth Android] Dados do utilizador ${user.email} atualizados.`);
      }
    } else {
      // Utilizador não encontrado, criar novo
      console.log(`[Auth Android] Utilizador não encontrado com googleId ${googleId}. Criando novo...`);
      const newUserResult = await query(
        'INSERT INTO users (google_id, email, name, profile_picture, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW()) RETURNING *',
        [googleId, email, name, picture]
      );
      user = newUserResult.rows[0];
      console.log(`[Auth Android] Novo utilizador criado: ${user.email}`);
    }

    // 3. Gerar o JWT da tua aplicação
    const jwtPayload = {
      id: user.id,
      googleId: user.google_id,
      email: user.email,
      name: user.name,
      picture: user.profile_picture
    };

    const appToken = jwt.sign(
      jwtPayload,
      process.env.JWT_SECRET, // A tua chave secreta do JWT
      { expiresIn: process.env.JWT_EXPIRES_IN || '1h' } // Tempo de expiração
    );

    // 4. Retornar o JWT da tua aplicação para a app Android
    res.status(200).json({
      message: "Autenticação bem-sucedida.",
      token: appToken, // Envia o teu JWT, não o idToken do Google
      user: jwtPayload // Envia também os dados do utilizador
    });

  } catch (error) {
    console.error('Erro durante a verificação do Google ID Token (Android):', error);
    // Tratar erros específicos (ex: token inválido, expirado)
    if (error.message.includes("Token used too late") || error.message.includes("Invalid IAT")) {
         return res.status(401).json({ message: 'Token Google expirado.' });
    } 
    if (error.message.includes("Wrong recipient")){
        return res.status(401).json({ message: 'Token Google inválido (audiência incorreta).' });
    }
    // Outros erros
    res.status(401).json({ message: 'Falha na autenticação com Google.' });
  }
};

module.exports = {
  googleCallback,
  loginSuccess,
  loginFailed,
  logout,
  checkStatus,
  googleSignInAndroid // Exportar a nova função
}; 