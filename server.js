const WebSocket = require('ws');
const fetch = require('node-fetch');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÕES DO TELEGRAM ---
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI";
const TG_CHAT_ID = "-1003355965894";
const LINK_CORRETORA = "https://track.deriv.com/_S_W1N_";

let configElite = {
    banca: 5000,
    entrada_perc: 1,
    payout: 95,
    gale: { tipo: "smart", nivel: 3 },
    emas: { e20: true, e200: false },
    timeframes: { m5: true, m15: true },
    padroes: { engolfo: true, hammer: true, tres_velas: true }
};

let motores = {};

// --- FUNÇÃO PARA PEGAR HORÁRIOS ---
function getHorarios() {
    const agora = new Date();
    const inicio = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    // Adiciona 1 minuto para o tempo de fim (expiração M1)
    const expira = new Date(agora.getTime() + 60000);
    const fim = expira.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    return { inicio, fim };
}

// --- FUNÇÃO DE MENSAGENS FORMATADAS ---
async function enviarTelegram(msg, comBotao = true) {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const payload = {
        chat_id: TG_CHAT_ID,
        text: msg,
        parse_mode: "Markdown",
        reply_markup: comBotao ? {
            inline_keyboard: [[{ text: "📲 ACESSAR CORRETORA", url: LINK_CORRETORA }]]
        } : undefined
    };

    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(e => console.log("Erro Telegram:", e.message));
}

// --- LÓGICA DE DETECÇÃO DE PADRÕES ---
function analisarEstrategia(velas) {
    if (velas.length < 5) return null;
    const c = velas[velas.length - 1]; // Candlestick Atual
    const a = velas[velas.length - 2]; // Anterior
    const r = velas[velas.length - 3]; // Retrasada

    const corpoC = Math.abs(c.close - c.open);
    const corpoA = Math.abs(a.close - a.open);

    // 1. ENGOLFO DE ALTA / BAIXA
    if (configElite.padroes.engolfo) {
        if (c.close > a.open && a.close < a.open && c.close > c.open && corpoC > corpoA)
            return { dir: "CALL", nome: "ENGOLFO DE ALTA 📈", emoji: "🟢" };
        if (c.close < a.open && a.close > a.open && c.close < c.open && corpoC > corpoA)
            return { dir: "PUT", nome: "ENGOLFO DE BAIXA 📉", emoji: "🔴" };
    }

    // 2. MARTELO (REVERSÃO)
    if (configElite.padroes.hammer) {
        const pavioInf = c.open > c.close ? c.low - c.close : c.low - c.open;
        if (pavioInf > (corpoC * 2.5)) return { dir: "CALL", nome: "MARTELO DE REVERSÃO 🔨", emoji: "🟢" };
    }

    // 3. 3 CORVOS (QUEDA FORTE)
    if (configElite.padroes.tres_velas) {
        if (c.close < a.close && a.close < r.close && c.close < c.open)
            return { dir: "PUT", nome: "3 CORVOS (BAIXA FORTE) 🦅", emoji: "🔴" };
    }

    return null;
}

// --- MOTOR DE PROCESSAMENTO ---
function iniciarMotor(cardId, ativoId, nomeAtivo) {
    if (motores[cardId]?.ws) motores[cardId].ws.terminate();
    if (ativoId === "NONE") return;

    let m = {
        nome: nomeAtivo,
        ws: new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089'),
        velas: [], preco: 0
    };

    m.ws.on('open', () => {
        m.ws.send(JSON.stringify({ ticks: ativoId }));
        m.ws.send(JSON.stringify({ ticks_history: ativoId, end: "latest", count: 30, granularity: 60, subscribe: 1 }));
    });

    m.ws.on('message', (data) => {
        const res = JSON.parse(data.toString());
        if (res.tick) m.preco = res.tick.quote;
        if (res.ohlc) {
            const candle = { open: res.ohlc.open, close: res.ohlc.close, low: res.ohlc.low, high: res.ohlc.high };
            if (m.velas.length > 30) m.velas.shift();
            m.velas.push(candle);

            const seg = new Date().getSeconds();

            // ALERTA DE PRÉ-SINAL (45s)
            if (seg === 45) {
                const sinal = analisarEstrategia(m.velas);
                if (sinal) {
                    enviarTelegram(`🔍 *ALERTA DE PRÉ-SINAL*\n\n📊 Ativo: ${m.nome}\n🎯 Estratégia: ${sinal.nome}\n⚡ Direção: ${sinal.dir}\n⏳ Aguarde a confirmação...`, false);
                }
            }

            // CONFIRMAÇÃO DE ENTRADA (00s)
            if (seg === 0) {
                const sinal = analisarEstrategia(m.velas);
                if (sinal) {
                    const { inicio, fim } = getHorarios();
                    const valor = (configElite.banca * (configElite.entrada_perc / 100)).toFixed(2);
                    enviarTelegram(`🚀 *ENTRADA CONFIRMADA*\n\n📊 Ativo: ${m.nome}\n🎯 Padrão: ${sinal.nome}\n📈 Operação: ${sinal.dir === "CALL" ? "COMPRA 🟢" : "VENDA 🔴"}\n💰 Valor: R$ ${valor}\n\n🕒 *HORÁRIO:* ${inicio}\n🏁 *TÉRMINO:* ${fim}\n\n🛡️ Proteção: Até Gale ${configElite.gale.nivel}\n⚙️ Modo: ${configElite.gale.tipo === 'smart' ? 'Gale Inteligente' : 'Dobra'}`);
                }
            }
        }
    });
    motores[cardId] = m;
}

app.post('/atualizar-config', (req, res) => {
    configElite = req.body;
    configElite.slots.forEach(s => iniciarMotor(s.id, s.ativo, s.nome));
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`BRAIN ELITE V3 ONLINE - PORTA ${PORT}`));
