const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI";
const TG_CHAT_ID = "-1003355965894";

let bancaAtual = 2000;
let placar = { direto: 0, g1: 0, g2: 0, g3: 0, red: 0 };
let configGlobal = {
    payout: 0.85,
    percentualEntrada: 1,
    gale: { tipo: 'smart', nivel: 2 },
    emas: { e10: true, e20: true, e100: false, e200: false },
    padroes: { engolfo: true, tvelas: true, fractal: false },
    timeframes: { m5: false, m15: false },
    slots: ["R_100", "R_75", "R_50", "R_25", "R_10", "1HZ100V"]
};

let estadosAtivos = {};

function calcularEMA(data, period) {
    if (data.length < period) return 0;
    let k = 2 / (period + 1);
    let ema = data[0].close;
    for (let i = 1; i < data.length; i++) {
        ema = (data[i].close * k) + (ema * (1 - k));
    }
    return ema;
}

async function analisarMercado(history, idAtivo) {
    if (history.length < 30) return null;
    const atual = history[history.length - 1];
    const anterior = history[history.length - 2];
    
    let sinal = null;
    let padraoNome = "";

    if (configGlobal.padroes.engolfo) {
        if (atual.close > atual.open && anterior.open > anterior.close && atual.close > anterior.open) { sinal = "CALL"; padraoNome = "ENGOLFO ALTA"; }
        if (atual.open > atual.close && anterior.close > anterior.open && atual.close < anterior.open) { sinal = "PUT"; padraoNome = "ENGOLFO BAIXA"; }
    }

    if (configGlobal.emas.e20 && sinal) {
        const e20 = calcularEMA(history, 20);
        if (sinal === "CALL" && atual.close < e20) return null;
        if (sinal === "PUT" && atual.close > e20) return null;
    }

    return sinal ? { direcao: sinal, padrao: padraoNome } : null;
}

async function enviarTelegram(msg) {
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown" })
    }).catch(e => console.log("Erro TG"));
}

async function executarCiclo(idAtivo, analise, nivelGale = 0) {
    const est = estadosAtivos[idAtivo];
    const valorEntrada = (bancaAtual * (configGlobal.percentualEntrada / 100) * Math.pow(2.1, nivelGale)).toFixed(2);
    
    let label = nivelGale === 0 ? "🚀 ENTRADA CONFIRMADA" : `🔄 GALE ${nivelGale}`;
    await enviarTelegram(`${label}\n📊 Ativo: ${idAtivo}\n📈 Direção: ${analise.direcao}\n💰 Valor: R$ ${valorEntrada}\n💵 Banca: R$ ${bancaAtual.toFixed(2)}`);

    setTimeout(async () => {
        const vela = est.history[est.history.length - 1];
        const win = (analise.direcao === "CALL" && vela.close > vela.open) || (analise.direcao === "PUT" && vela.close < vela.open);

        if (win) {
            bancaAtual += valorEntrada * configGlobal.payout;
            placar.direto++;
            enviarTelegram(`✅ WIN! Placar: ${placar.direto}W - ${placar.red}L`);
            est.emOperacao = false;
        } else if (nivelGale < configGlobal.gale.nivel) {
            executarCiclo(idAtivo, analise, nivelGale + 1);
        } else {
            bancaAtual -= valorEntrada;
            placar.red++;
            enviarTelegram(`❌ RED! Banca: R$ ${bancaAtual.toFixed(2)}`);
            est.emOperacao = false;
        }
    }, 61000);
}

function conectar(idAtivo) {
    if (idAtivo === "NONE") return;
    const ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

    ws.on('open', () => {
        ws.send(JSON.stringify({ ticks_history: idAtivo, end: "latest", count: 100, style: "candles", granularity: 60, subscribe: 1 }));
    });

    ws.on('message', async (data) => {
        const res = JSON.parse(data);
        if (!estadosAtivos[idAtivo]) estadosAtivos[idAtivo] = { history: [], lastTime: 0, alertaEnviado: false, sinalPendente: null, emOperacao: false };
        const est = estadosAtivos[idAtivo];

        if (res.candles) est.history = res.candles;
        if (res.ohlc) {
            const o = res.ohlc;
            const segundos = new Date().getSeconds();

            // --- LÓGICA DE ALERTA (AOS 50 SEGUNDOS) ---
            if (segundos >= 50 && segundos < 58 && !est.alertaEnviado && !est.emOperacao) {
                const analise = await analisarMercado(est.history, idAtivo);
                if (analise) {
                    est.alertaEnviado = true;
                    est.sinalPendente = analise;
                    enviarTelegram(`⚠️ *ALERTA BRAIN PRO*\n📊 Ativo: ${idAtivo}\n🎯 Padrão: ${analise.padrao}\n⏳ Analisando virada...`);
                }
            }

            // --- VIRADA DA VELA (CONFIRMA OU ABORTA) ---
            if (o.open_time !== est.lastTime) {
                if (est.alertaEnviado) {
                    const confirmacao = await analisarMercado(est.history, idAtivo);
                    if (confirmacao && confirmacao.direcao === est.sinalPendente.direcao) {
                        est.emOperacao = true;
                        executarCiclo(idAtivo, confirmacao);
                    } else {
                        enviarTelegram(`❌ *ALERTA ABORTADO*\n📊 Ativo: ${idAtivo}\nPadrão desfeito na virada.`);
                    }
                }
                est.alertaEnviado = false;
                est.sinalPendente = null;
                est.lastTime = o.open_time;
                est.history.push({ open: o.open, close: o.close });
                if (est.history.length > 100) est.history.shift();
            }
        }
    });

    ws.on('close', () => setTimeout(() => conectar(idAtivo), 5000));
}

app.post('/atualizar-config', (req, res) => {
    configGlobal = { ...configGlobal, ...req.body };
    bancaAtual = parseFloat(req.body.banca) || bancaAtual;
    configGlobal.slots.forEach(id => conectar(id));
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`🚀 Cérebro Online!`);
    configGlobal.slots.forEach(id => conectar(id));
});
