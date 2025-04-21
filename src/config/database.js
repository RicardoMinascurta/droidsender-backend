const { Pool } = require('pg');

// Verifica se a variável de ambiente DATABASE_URL está definida
if (!process.env.DATABASE_URL) {
  throw new Error('Erro Crítico: Variável de ambiente DATABASE_URL não está definida!');
}

// Cria um novo pool de conexões usando a URL do .env
// O pool gere múltiplas conexões para eficiência.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Configurações adicionais do pool podem ser adicionadas aqui, se necessário
  // Ativa SSL para produção (ex: Heroku)
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Tenta conectar para verificar a configuração
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Erro ao conectar à base de dados PostgreSQL:', err.stack);
    // Considerar terminar a aplicação se a conexão inicial falhar?
    // process.exit(1);
  } else {
    console.log('✅ Conexão com a base de dados PostgreSQL estabelecida com sucesso!');
    // Liberta o cliente de volta para o pool
    release();
  }
});

// Exporta uma função para executar queries e o próprio pool
module.exports = {
  query: (text, params) => pool.query(text, params),
  pool: pool, // Exporta o pool caso seja necessário para transações ou outras operações
}; 