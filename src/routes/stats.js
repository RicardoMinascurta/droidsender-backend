const express = require('express');
const router = express.Router();
const { query } = require('../config/database'); // Ajuste o caminho se necessário
const { ensureAuthenticated } = require('../middleware/authMiddleware'); // Corrigir a importação para extrair a função do objeto exportado

// Helper para formatar data como YYYY-MM-DD (garantindo UTC)
const formatDateUTC = (date) => date.toISOString().split('T')[0];

// GET /api/stats
// Retorna estatísticas de envio de SMS para um determinado período
// Query Params:
// - period: 'day', 'week', 'month' (obrigatório)
// - referenceDate: 'YYYY-MM-DD' (opcional, padrão: data atual)
router.get('/', ensureAuthenticated, async (req, res) => {
    const userId = req.user.id;
    const { period, referenceDate: referenceDateStr } = req.query;
    
    // --- Determinar Fuso Horário --- 
    const defaultTimeZone = 'UTC'; // Usar UTC como padrão universal
    // Tenta obter do perfil do utilizador (assumindo que existe req.user.timezone)
    const userTimeZone = req.user.timezone || defaultTimeZone;
    // TODO: Adicionar validação se o timezone do user é válido (ex: usando uma biblioteca como moment-timezone)
    console.log(`[Stats API] Determined TimeZone to use: ${userTimeZone} (Default: ${defaultTimeZone})`);
    
    if (!['day', 'week', 'month'].includes(period)) {
        return res.status(400).json({ message: "Parâmetro 'period' inválido." });
    }

    let referenceDate;
    try {
        referenceDate = referenceDateStr ? new Date(referenceDateStr + 'T00:00:00Z') : new Date();
        if (isNaN(referenceDate.getTime())) throw new Error('Data inválida');
        referenceDate.setUTCHours(0, 0, 0, 0);
    } catch (e) {
        return res.status(400).json({ message: "Parâmetro 'referenceDate' inválido (YYYY-MM-DD)." });
    }

    let startDate, endDate;
    const year = referenceDate.getUTCFullYear();
    const month = referenceDate.getUTCMonth();
    const day = referenceDate.getUTCDate();

    try {
        // Definir datas de início/fim UTC
        switch (period) {
            case 'day':
                startDate = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
                endDate = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
                break;
            case 'week':
                const dayOfWeek = referenceDate.getUTCDay();
                const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
                startDate = new Date(Date.UTC(year, month, day + diffToMonday, 0, 0, 0, 0));
                endDate = new Date(startDate);
                endDate.setUTCDate(startDate.getUTCDate() + 6);
                endDate.setUTCHours(23, 59, 59, 999);
                break;
            case 'month':
                startDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
                endDate = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
                break;
        }

        const startDateStr = startDate.toISOString();
        const endDateStr = endDate.toISOString();

        console.log(`[Stats API] Period: ${period}, RefDate: ${referenceDateStr || 'Now'}, Start UTC: ${startDateStr}, End UTC: ${endDateStr}, User: ${userId}`);

        let statsQuery;
        let queryParams = [userId, startDateStr, endDateStr, userTimeZone];
        let results = [];

        console.log(`[Stats API] Using TimeZone Parameter: ${userTimeZone}`);

        if (period === 'day') {
            statsQuery = `
                SELECT
                    EXTRACT(HOUR FROM r.updated_at AT TIME ZONE $4) AS hour,
                    SUM(CASE WHEN r.status IN ('sent', 'delivered') THEN 1 ELSE 0 END) AS sent_count,
                    SUM(CASE WHEN r.status IN ('failed', 'delivery_failed') THEN 1 ELSE 0 END) AS failed_count
                FROM recipients r
                JOIN campaigns c ON r.campaign_id = c.id
                WHERE
                    c.user_id = $1 AND
                    r.updated_at >= $2::timestamptz AND 
                    r.updated_at <= $3::timestamptz AND 
                    r.status IN ('sent', 'delivered', 'failed', 'delivery_failed')
                GROUP BY hour
                ORDER BY hour ASC;
            `;
            const result = await query(statsQuery, queryParams);
            console.log("[Stats API - Day] Raw DB Result:", result.rows); // LOG RAW RESULT
            
            // Preencher as 24 horas
            const hourlyMap = new Map();
            result.rows.forEach(row => {
                hourlyMap.set(parseInt(row.hour, 10), {
                    sent: parseInt(row.sent_count, 10),
                    failed: parseInt(row.failed_count, 10)
                });
            });

            for (let hour = 0; hour < 24; hour++) {
                const stats = hourlyMap.get(hour) || { sent: 0, failed: 0 };
                results.push({
                    hour: hour,
                    sent: stats.sent,
                    failed: stats.failed
                });
            }

        } else { // week or month
             statsQuery = `
                SELECT
                    to_char(r.updated_at AT TIME ZONE $4, 'YYYY-MM-DD') AS local_date_str,
                    EXTRACT(ISODOW FROM r.updated_at AT TIME ZONE $4) AS local_weekday, 
                    EXTRACT(DAY FROM r.updated_at AT TIME ZONE $4) AS local_day_of_month,
                    SUM(CASE WHEN r.status IN ('sent', 'delivered') THEN 1 ELSE 0 END) AS sent_count,
                    SUM(CASE WHEN r.status IN ('failed', 'delivery_failed') THEN 1 ELSE 0 END) AS failed_count
                FROM recipients r
                JOIN campaigns c ON r.campaign_id = c.id
                WHERE
                    c.user_id = $1 AND
                    r.updated_at >= $2::timestamptz AND 
                    r.updated_at <= $3::timestamptz AND 
                    r.status IN ('sent', 'delivered', 'failed', 'delivery_failed')
                GROUP BY local_date_str, local_weekday, local_day_of_month 
                ORDER BY local_date_str ASC;
            `;
            const result = await query(statsQuery, queryParams);
            console.log(`[Stats API - ${period}] Raw DB Result (Group by local date):`, result.rows);

            // --- SIMPLIFICAÇÃO: Retornar apenas os dias/rows que têm dados --- 
            results = result.rows.map(row => ({
                date: row.local_date_str,
                weekday: parseInt(row.local_weekday, 10),
                dayOfMonth: parseInt(row.local_day_of_month, 10),
                sent: parseInt(row.sent_count, 10),
                failed: parseInt(row.failed_count, 10)
            }));
            // A lógica de preenchimento foi REMOVIDA daqui. Será feita no frontend.
        }
        
        // --- RESPOSTA PADRONIZADA --- 
        console.log(`[Stats API - ${period}] Final results array length: ${results.length}`);
        res.json({
            period: period,
            // Não retornar startDate/endDate que eram UTC e não batiam certo com os dados locais
            stats: results // Array (pode estar incompleto para week/month, frontend preenche)
        });

    } catch (error) {
       console.error('[Stats API] Erro ao buscar estatísticas:', error);
       res.status(500).json({ message: 'Erro interno ao buscar estatísticas.' });
    }
});

module.exports = router;
