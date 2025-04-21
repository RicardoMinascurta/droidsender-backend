const { query } = require('../config/database');

// Controlador para obter os detalhes do utilizador autenticado
const getMe = async (req, res) => {
  // O middleware ensureAuthenticated garante que req.user está definido
  if (!req.user) {
    // Segurança extra, embora o middleware deva impedir isto
    return res.status(401).json({ message: 'Utilizador não autenticado.' });
  }

  try {
    // Buscar dados adicionais se necessário, mas por agora retornamos o que já temos
    // Se quiséssemos dados mais recentes:
    // const userResult = await query('SELECT id, email, google_id, subscription_plan, created_at, updated_at FROM users WHERE id = $1', [req.user.id]);
    // const currentUser = userResult.rows[0];
    // if (!currentUser) {
    //   return res.status(404).json({ message: 'Utilizador não encontrado na base de dados.' });
    // }

    // Retorna apenas os dados não sensíveis do objeto req.user que o Passport já populou
    const safeUserData = {
      id: req.user.id,
      email: req.user.email,
      google_id: req.user.google_id, // Considerar se deve ser exposto na API
      subscription_plan: req.user.subscription_plan,
      stripe_customer_id: req.user.stripe_customer_id,
      created_at: req.user.created_at,
      updated_at: req.user.updated_at,
    };

    res.json(safeUserData);

  } catch (error) {
    console.error('Erro ao obter dados do utilizador /me:', error);
    res.status(500).json({ message: 'Erro interno do servidor ao obter dados do utilizador.' });
  }
};

// TODO: Adicionar controladores para atualizar perfil, etc.

module.exports = {
  getMe,
}; 