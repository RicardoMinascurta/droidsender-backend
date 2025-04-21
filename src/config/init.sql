-- backend/src/config/init.sql
-- Script para criar as tabelas iniciais da base de dados DroidSender

-- Tabela de Utilizadores
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  google_id VARCHAR(255) UNIQUE, -- ID único fornecido pelo Google OAuth
  subscription_plan VARCHAR(50) DEFAULT 'free' NOT NULL,
  subscription_ends_at TIMESTAMP, -- Data de fim da subscrição (para planos pagos)
  stripe_customer_id VARCHAR(255) UNIQUE, -- ID do cliente no Stripe (para pagamentos)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Tabela de Dispositivos Conectados
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- Chave estrangeira para users
  device_id VARCHAR(255) NOT NULL, -- Identificador único do dispositivo (gerado pela app Android?)
  device_name VARCHAR(255), -- Nome dado pelo utilizador (opcional)
  device_model VARCHAR(255), -- Modelo do telemóvel
  is_active BOOLEAN DEFAULT true NOT NULL, -- Indica se o dispositivo está ativo/permitido
  last_seen TIMESTAMP, -- Última vez que esteve online (atualizado via WebSocket)
  battery_level INTEGER, -- Nível da bateria (atualizado via WebSocket)
  fcm_token TEXT UNIQUE, -- Token do Firebase Cloud Messaging para notificações push (opcional)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, device_id) -- Um utilizador não pode ter o mesmo device_id duas vezes
);

-- Tabela de Campanhas de SMS
CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  message_template TEXT NOT NULL, -- Mensagem a ser enviada (pode conter variáveis)
  status VARCHAR(50) DEFAULT 'draft' NOT NULL, -- Ex: draft, scheduled, sending, paused, completed, failed
  scheduled_at TIMESTAMP, -- Data/hora para agendamento (NULL se for envio imediato)
  started_at TIMESTAMP, -- Data/hora em que o envio começou
  completed_at TIMESTAMP, -- Data/hora em que o envio terminou (ou foi cancelado)
  recipients_total INTEGER DEFAULT 0 NOT NULL, -- Total de números no ficheiro original
  recipients_processed INTEGER DEFAULT 0 NOT NULL, -- Quantos foram enviados/falharam
  success_count INTEGER DEFAULT 0 NOT NULL, -- Quantos enviados com sucesso
  failure_count INTEGER DEFAULT 0 NOT NULL, -- Quantos falharam
  source_file_name VARCHAR(255), -- Nome do ficheiro Excel/CSV original
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Tabela de Destinatários (Números dentro de uma campanha)
CREATE TABLE IF NOT EXISTS recipients (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  phone_number VARCHAR(50) NOT NULL, -- Número de telemóvel do destinatário
  variables JSONB, -- Coluna para guardar variáveis personalizadas (ex: {"nome": "Ricardo"})
  status VARCHAR(50) DEFAULT 'pending' NOT NULL, -- Ex: pending, sent, delivered, failed
  sent_at TIMESTAMP, -- Data/hora do envio pelo dispositivo
  delivered_at TIMESTAMP, -- Data/hora da entrega (se conseguirmos obter do Android)
  error_message TEXT, -- Mensagem de erro em caso de falha
  retry_count INTEGER DEFAULT 0 NOT NULL, -- Número de tentativas de reenvio
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Tabela para API Keys (Adicionada para a API Pública)
CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash VARCHAR(255) UNIQUE NOT NULL, -- Hash da API Key (não guardar a chave em texto claro!)
  prefix VARCHAR(8) UNIQUE NOT NULL, -- Primeiros caracteres da chave para identificação
  name VARCHAR(100), -- Nome descritivo dado pelo utilizador
  last_used_at TIMESTAMP,
  expires_at TIMESTAMP, -- Data de expiração (opcional)
  is_active BOOLEAN DEFAULT true NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Índices para otimizar queries comuns
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_user_id ON campaigns(user_id);
CREATE INDEX IF NOT EXISTS idx_recipients_campaign_id ON recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_recipients_status ON recipients(status);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);

-- Função para atualizar automaticamente o campo updated_at
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers para chamar a função trigger_set_timestamp em updates
DO $$ BEGIN
  CREATE TRIGGER set_timestamp_users
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_timestamp();
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_timestamp_devices
  BEFORE UPDATE ON devices
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_timestamp();
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_timestamp_campaigns
  BEFORE UPDATE ON campaigns
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_timestamp();
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_timestamp_recipients
  BEFORE UPDATE ON recipients
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_timestamp();
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TRIGGER set_timestamp_api_keys
  BEFORE UPDATE ON api_keys
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_timestamp();
EXCEPTION
  WHEN duplicate_object THEN null;
END $$; 