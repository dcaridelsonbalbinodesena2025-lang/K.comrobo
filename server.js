const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÕES DO TELEGRAM ---
const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI";
const TG_CHAT_ID = "-1003355965894";

// --- ESTADO GLOBAL (O que o Painel controla) ---
let configGlobal = {
    bancaAtual: 1000.00,
    payout: 0.85,
    percentualEntrada: 1,
    ativosAtivos: ["R_100", "R_75", "R_50", "R_25", "R_10", "1HZ100V"],
    filtros: { engolfo: true, martelo: false, ema: true, tendencia_m5: false }
};

let estadosAtivos = {};
let placar = { win: 0, g1: 0, g2: 0, loss: 0 };

// Inicializa o estado de cada ativo
configGlobal.ativosAtivos.forEach(id => {
    estadosAtivos[id] = { history: [], lastCandleTime: 0, sinalPendente: null, alertaEnviado: false };
});

// --- ROTA PARA O PAINEL MANDAR ORDENS ---
app.post('/atualizar-config', (req, res) => {
    const novaConfig = req.body;
    configGlobal.bancaAtual = parseFloat(novaConfig.banca);
    configGlobal.payout = parseFloat(novaConfig.payout) / 100;
    configGlobal.percentualEntrada = parseFloat(novaConfig.entrada);
    configGlobal.filtros = novaConfig.filtros;
    configGlobal.ativosAtivos = novaConfig.ativos_ativos;
    
    console.log("✅ Cérebro Atualizado pelo Painel!");
    res.sendStatus(200);
});

// --- FUNÇÃO DE MENSAGEM ---
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
function analisarPadrao(candles, idAtivo) {
    if (!configGlobal.ativosAtivos.includes(idAtivo)) return null;
    if (candles.length < 2) return null;

    const atual = candles[candles.length - 1];
    const anterior = candles[candles.length - 2];

    // Só analisa Engolfo se estiver ativo no Painel
    if (configGlobal.filtros.engolfo) {
        if (atual.close > atual.open && anterior.open > anterior.close && atual.close > anterior.open) {
            return { nome: "ENGOLFO ALTA", dir: "CALL" };
        }
        if (atual.open > atual.close && anterior.close > anterior.open && atual.close < anterior.open) {
            return { nome: "ENGOLFO BAIXA", dir: "PUT" };
        }
    }
    return null;
}

// --- CONEXÃO COM A DERIV ---
function conectar(idAtivo) {
    const ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

    ws.on('open', () => {
        ws.send(JSON.stringify({
            ticks_history: idAtivo, end: "latest", count: 50, style: "candles", granularity: 60, subscribe: 1
        }));
    });

    ws.on('message', (data) => {
        const res = JSON.parse(data);
        const est = estadosAtivos[idAtivo];
        if (!est) return;

        if (res.candles) est.history = res.candles;

        if (res.ohlc) {
            const ohlc = res.ohlc;
            const segundos = new Date().getSeconds();

            // ALERTA PRÉVIO (Aos 45 seg)
            if (segundos >= 45 && !est.alertaEnviado) {
                const padrao = analisarPadrao([...est.history, { open: ohlc.open, close: ohlc.close }], idAtivo);
                if (padrao) {
                    est.alertaEnviado = true;
                    est.sinalPendente = padrao;
                    enviarTelegram(`⚠️ *ALERTA BRAIN PRO*\n\n📊 Ativo: ${idAtivo}\n🎯 Padrão: ${padrao.nome}\n🕓 Analisando virada de vela...`);
                }
            }

            // VIRADA DE VELA (Execução)
            if (ohlc.open_time !== est.lastCandleTime) {
                if (est.alertaEnviado) {
                    const padraoFinal = analisarPadrao(est.history, idAtivo);
                    if (padraoFinal && padraoFinal.nome === est.sinalPendente.nome) {
                        const valorEntrada = (configGlobal.bancaAtual * (configGlobal.percentualEntrada / 100)).toFixed(2);
                        enviarTelegram(`🚀 *ENTRADA CONFIRMADA*\n\n📊 Ativo: ${idAtivo}\n📈 Direção: ${padraoFinal.dir}\n💰 Valor: R$ ${valorEntrada}\n💰 Banca: R$ ${configGlobal.bancaAtual.toFixed(2)}`);
                    } else {
                        enviarTelegram(`❌ *ALERTA ABORTADO*\n\n📊 Ativo: ${idAtivo}\n📢 Padrão desfeito na virada.`);
                    }
                }
                est.lastCandleTime = ohlc.open_time;
                est.alertaEnviado = false;
                est.sinalPendente = null;
                est.history.push({ open: ohlc.open, close: ohlc.close });
                if (est.history.length > 60) est.history.shift();
            }
        }
    });

    ws.on('close', () => setTimeout(() => conectar(idAtivo), 5000));
}

// Inicia todos os ativos
configGlobal.ativosAtivos.forEach(id => conectar(id));

app.listen(PORT, () => console.log(`🚀 Cérebro Online na porta ${PORT}`));
