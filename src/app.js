const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const passport = require('passport');

// Carregar a configuração do Passport (isto executa o código em passport.js)
require('./config/passport');

// Cria a instância da aplicação Express
const app = express();

// --- Middlewares Essenciais ---

// Habilita Cross-Origin Resource Sharing (CORS) para permitir pedidos do frontend
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173', // URL do frontend
  credentials: true, // Importante para permitir cookies/autenticação
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Define vários cabeçalhos HTTP de segurança
app.use(helmet());

// Middleware para fazer parse do corpo dos pedidos como JSON
app.use(express.json());

// Middleware para fazer parse de corpos codificados em URL (ex: formulários HTML)
app.use(express.urlencoded({ extended: true }));

// --- Configuração da Sessão ---
if (!process.env.SESSION_SECRET) {
  console.warn('Atenção: Variável de ambiente SESSION_SECRET não definida! Usando valor padrão inseguro.');
  // Considerar lançar um erro em produção se o segredo não estiver definido
}
app.use(session({
  secret: process.env.SESSION_SECRET || 'default_insecure_session_secret', // Segredo para assinar o cookie da sessão
  resave: false, // Não guardar a sessão se não for modificada
  saveUninitialized: false, // Não criar sessão até algo ser guardado
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias em milissegundos
    secure: process.env.NODE_ENV === 'production', // Usar HTTPS apenas em produção
    httpOnly: true, // Não acessível via JavaScript
    sameSite: 'lax' // Protege contra CSRF
  }
}));

// --- Inicialização do Passport ---
app.use(passport.initialize()); // Inicializa o Passport
app.use(passport.session()); // Permite que o Passport use sessões

// --- Rotas ---

// Rota de teste inicial
app.get('/', (req, res) => {
  // Verifica se o utilizador está autenticado (disponível após deserialização)
  const userInfo = req.user ? { id: req.user.id, email: req.user.email } : 'Não autenticado';
  res.json({ 
    message: 'Bem-vindo à API do DroidSender!', 
    session: req.session, // Informação da sessão (inclui passport.user com o ID serializado)
    user: userInfo // Informação do utilizador (após deserialização)
  });
});

// Rotas de Autenticação
const authRoutes = require('./routes/auth');
app.use('/auth', authRoutes);

// Rotas de Utilizadores
const userRoutes = require('./routes/users');
app.use('/api/users', userRoutes); // Monta as rotas de utilizador em /api/users

// Rotas de Dispositivos
const deviceRoutes = require('./routes/devices'); // Importa as rotas de dispositivos
app.use('/api/devices', deviceRoutes); // Monta as rotas de dispositivos em /api/devices

// Rotas de Campanhas
const campaignRoutes = require('./routes/campaigns'); // Importa as rotas de campanhas
app.use('/api/campaigns', campaignRoutes); // Monta as rotas de campanhas em /api/campaigns

// TODO: Importar e usar as rotas de campanhas, etc. aqui

// --- Tratamento de Erros ---
// TODO: Implementar middleware de tratamento de erros centralizado

// Exporta a instância da app para ser usada no server.js
module.exports = app; 