const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÕES ---
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI";
const TG_CHAT_ID = "-1003355965894";

const ATIVOS = [
    { id: "R_100", nome: "Volatility 100" },
    { id: "R_75", nome: "Volatility 75" },
    { id: "R_50", nome: "Volatility 50" },
    { id: "R_25", nome: "Volatility 25" },
    { id: "R_10", nome: "Volatility 10" },
    { id: "1HZ100V", nome: "Volatility 100 (1s)" }
];

// ESTADO GLOBAL
let config = { bancaAtual: 1000.00, percentualEntrada: 1, payout: 0.85 };
let estados = {}; 

ATIVOS.forEach(a => {
    estados[a.id] = { history: [], lastCandleTime: 0, sinalPendente: null, alertaEnviado: false };
});

// --- FUNÇÕES DE MENSAGENS (Aquelas que você pediu) ---

function obterHorarios() {
    const agora = new Date();
    const hIn = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const hFim = new Date(agora.getTime() + 60000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return { hIn, hFim };
}

async function enviarTelegram(msg) {
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown" })
        });
    } catch (e) { console.log("Erro Telegram"); }
}

// --- LÓGICA DE ANÁLISE ---

function analisarPadrao(candles) {
    if (candles.length < 2) return null;
    const atual = candles[candles.length - 1];
    const anterior = candles[candles.length - 2];

    if (atual.close > atual.open && anterior.open > anterior.close && atual.close > anterior.open) {
        return { nome: "ENGOLFO ALTA", dir: "CALL" };
    }
    if (atual.open > atual.close && anterior.close > anterior.open && atual.close < anterior.open) {
        return { nome: "ENGOLFO BAIXA", dir: "PUT" };
    }
    return null;
}

// --- CONEXÃO MULTI-ATIVOS ---

function conectarAtivo(ativo) {
    const ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

    ws.on('open', () => {
        ws.send(JSON.stringify({
            ticks_history: ativo.id, end: "latest", count: 50, style: "candles", granularity: 60, subscribe: 1
        }));
    });

    ws.on('message', (data) => {
        const res = JSON.parse(data);
        const est = estados[ativo.id];

        if (res.candles) est.history = res.candles;

        if (res.ohlc) {
            const ohlc = res.ohlc;
            const segundos = new Date().getSeconds();

            // 1. LÓGICA DE ALERTA (Aos 45 segundos)
            if (segundos >= 45 && !est.alertaEnviado) {
                const padrao = analisarPadrao([...est.history, { open: ohlc.open, close: ohlc.close }]);
                if (padrao) {
                    est.alertaEnviado = true;
                    est.sinalPendente = padrao;
                    const hEntrada = new Date(new Date().getTime() + (60 - segundos) * 1000).toLocaleTimeString('pt-BR');
                    enviarTelegram(`⚠️ *ALERTA BRAIN PRO*\n\n📊 Ativo: ${ativo.nome}\n🎯 Padrão: ${padrao.nome}\n📈 Filtro: PADRÃO PURO ✅\n🕓 Possível entrada: ${hEntrada}`);
                }
            }

            // 2. VIRADA DE VELA
            if (ohlc.open_time !== est.lastCandleTime) {
                if (est.alertaEnviado) {
                    const padraoFinal = analisarPadrao(est.history);
                    if (padraoFinal && padraoFinal.nome === est.sinalPendente.nome) {
                        // ENTRADA CONFIRMADA
                        const { hIn, hFim } = obterHorarios();
                        const valor = (config.bancaAtual * (config.percentualEntrada / 100)).toFixed(2);
                        enviarTelegram(`🚀 *ENTRADA CONFIRMADA*\n\n👉Clique agora!\n📊 Ativo: ${ativo.nome}\n🎯 Padrão: ${padraoFinal.nome}\n📈 Direção: ${padraoFinal.dir}\n💰 Entrada: R$ ${valor}\n💰 Banca: R$ ${config.bancaAtual.toFixed(2)}\n⏰ Inicio: ${hIn}\n🏁 Fim: ${hFim}`);
                    } else {
                        // ABORTADO
                        enviarTelegram(`❌ *ALERTA ABORTADO*\n\n📊 Ativo: ${ativo.nome}\n📈 Direção: ${est.sinalPendente.dir}\n⏰ Horário: ${new Date().toLocaleTimeString()}\n📢 Motivo: Perda de padrão na virada.`);
                    }
                }
                est.lastCandleTime = ohlc.open_time;
                est.alertaEnviado = false;
                est.sinalPendente = null;
                est.history.push({ open: ohlc.open, close: ohlc.close });
            }
        }
    });

    ws.on('close', () => setTimeout(() => conectarAtivo(ativo), 5000));
}

ATIVOS.forEach(a => conectarAtivo(a));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`SERVIDOR RODANDO NA PORTA ${PORT}`));
