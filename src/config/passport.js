const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const JwtStrategy = require('passport-jwt').Strategy;
const ExtractJwt = require('passport-jwt').ExtractJwt;
const { query } = require('./database'); // Importa a função de query do nosso módulo DB

// Verifica se as variáveis de ambiente essenciais estão definidas
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_CALLBACK_URL) {
  throw new Error('Erro Crítico: Variáveis de ambiente GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET ou GOOGLE_CALLBACK_URL não estão definidas!');
}

// Verificar se JWT_SECRET está definido
if (!process.env.JWT_SECRET) {
  throw new Error('Erro Crítico: Variável de ambiente JWT_SECRET não está definida!');
}

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
  },
  async (accessToken, refreshToken, profile, done) => {
    // Esta função é chamada após o Google autenticar o utilizador com sucesso
    // 'profile' contém as informações do utilizador do Google

    const googleId = profile.id;
    const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
    // const displayName = profile.displayName;
    // const photoUrl = profile.photos && profile.photos[0] ? profile.photos[0].value : null;

    if (!email) {
      // Não conseguimos obter o email, que é essencial para nós
      return done(new Error('Não foi possível obter o email do perfil Google.'), null);
    }

    try {
      // 1. Tenta encontrar o utilizador pelo Google ID
      let userResult = await query('SELECT * FROM users WHERE google_id = $1', [googleId]);
      let user = userResult.rows[0];

      if (user) {
        // Utilizador encontrado pelo Google ID, retorna-o
        console.log(`[Passport Google] Utilizador encontrado por Google ID: ${email}`);
        return done(null, user);
      }

      // 2. Se não encontrou por Google ID, tenta encontrar pelo Email
      userResult = await query('SELECT * FROM users WHERE email = $1', [email]);
      user = userResult.rows[0];

      if (user) {
        // Utilizador encontrado por email, mas sem Google ID associado.
        // Atualiza o utilizador existente com o Google ID.
        console.log(`[Passport Google] Utilizador encontrado por Email, atualizando Google ID: ${email}`);
        const updateUserResult = await query(
          'UPDATE users SET google_id = $1, updated_at = NOW() WHERE email = $2 RETURNING *',
          [googleId, email]
        );
        user = updateUserResult.rows[0];
        return done(null, user);
      }

      // 3. Se não encontrou nem por Google ID nem por Email, cria um novo utilizador
      console.log(`[Passport Google] Criando novo utilizador: ${email}`);
      const createUserResult = await query(
        'INSERT INTO users (email, google_id, updated_at) VALUES ($1, $2, NOW()) RETURNING *',
        [email, googleId]
      );
      user = createUserResult.rows[0];
      return done(null, user);

    } catch (err) {
      console.error('[Passport Google] Erro ao procurar/criar utilizador:', err);
      return done(err, null);
    }
  }
));

// --- Estratégia JWT --- 
const jwtOptions = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), // Extrai o token do cabeçalho Authorization: Bearer <token>
  secretOrKey: process.env.JWT_SECRET // Usa o segredo do .env para verificar a assinatura
};

passport.use(new JwtStrategy(jwtOptions, async (jwt_payload, done) => {
  // jwt_payload contém os dados que colocámos no token ao criá-lo (ex: id do user)
  console.log(`[Passport JWT] Verificando token para user ID: ${jwt_payload.id}`); // ou jwt_payload.sub se usaste 'sub'
  try {
    // Busca o utilizador na DB usando o ID do payload
    const result = await query('SELECT id, email, created_at, updated_at FROM users WHERE id = $1', [jwt_payload.id]); // Removido subscription_plan
    const user = result.rows[0];

    if (user) {
      // Utilizador encontrado e token válido
      console.log(`[Passport JWT] Token válido, utilizador encontrado: ${user.email}`);
      return done(null, user); // Passa o user (sem a password!) para o próximo middleware (req.user)
    } else {
      // Utilizador não encontrado na DB (token pode ser válido mas user foi deletado?)
      console.warn(`[Passport JWT] Token válido, mas utilizador ID ${jwt_payload.id} não encontrado na DB.`);
      return done(null, false); // Indica falha na autenticação (user não existe)
    }
  } catch (error) {
    // Erro ao aceder à base de dados
    console.error('[Passport JWT] Erro na DB ao verificar utilizador:', error);
    return done(error, false); // Indica erro
  }
}));

// Serialização: Guarda apenas o ID do user na sessão
passport.serializeUser((user, done) => {
  // Verifica se o objeto user e user.id existem antes de serializar
  if (user && user.id) {
      done(null, user.id);
  } else {
      console.error("[Passport Serialize] Tentativa de serializar utilizador inválido ou sem ID:", user);
      done(new Error('Objeto de utilizador inválido para serialização'), null);
  }
});

// Deserialização: Usa o ID da sessão para buscar o user completo na DB
passport.deserializeUser(async (id, done) => {
  console.log(`[Passport Deserialize] Tentando deserializar user ID: ${id}`);
  try {
    // Busca o user completo (sem password) para popular req.user
    const result = await query('SELECT id, email, created_at, updated_at FROM users WHERE id = $1', [id]); // Removido subscription_plan
    const user = result.rows[0];
    if (user) {
        console.log(`[Passport Deserialize] Utilizador ID ${id} encontrado: ${user.email}`);
        done(null, user);
    } else {
        console.warn(`[Passport Deserialize] Utilizador ID ${id} não encontrado na DB.`);
        done(null, false); // Ou done(new Error(`User with ID ${id} not found`))?
    }
  } catch (err) {
    console.error(`[Passport Deserialize] Erro na DB ao deserializar user ID ${id}:`, err);
    done(err, null);
  }
});

// Não precisamos de exportar nada diretamente, o Passport gere isto internamente
// após esta configuração ser importada noutro local (ex: app.js) 