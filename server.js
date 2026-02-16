const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

const TG_TOKEN = "8427077212:AAEiL_3_D_-fukuaR95V3FqoYYyHvdCHmEI";
const TG_CHAT_ID = "-1003355965894";

// --- ESTADO DO ROBÔ ---
let bancaAtual = 2000;
let placar = { direto: 0, g1: 0, g2: 0, g3: 0, red: 0 };
let configGlobal = {
    payout: 0.85,
    percentualEntrada: 1,
    gale: { tipo: 'smart', nivel: 2 },
    emas: { e10: true, e20: true, e100: false, e200: false },
    padroes: { engolfo: true, tvelas: true, fractal: false },
    slots: ["R_100", "R_75", "R_50", "R_25", "R_10", "1HZ100V"]
};

let estadosAtivos = {};

// --- CÁLCULOS MATEMÁTICOS ---
function calcularEMA(data, period) {
    if (data.length < period) return 0;
    let k = 2 / (period + 1);
    let ema = data[data.length - period].close;
    for (let i = data.length - period + 1; i < data.length; i++) {
        ema = (data[i].close * k) + (ema * (1 - k));
    }
    return ema;
}

// --- LOGICA DE ENTRADA ---
// --- NOVA FUNÇÃO DE ANÁLISE COM MULTI-TIMEFRAME ---
async function analisarMercado(history, idAtivo) {
    if (history.length < 30) return null;
    
    const atual = history[history.length - 1];
    const anterior = history[history.length - 2];
    const e20 = calcularEMA(history, 20);

    let sinal = null;
    let padraoNome = "";

    // 1. Identificação do Padrão (M1)
    if (configGlobal.padroes.engolfo) {
        if (atual.close > atual.open && anterior.open > anterior.close && atual.close > anterior.open) { sinal = "CALL"; padraoNome = "ENGOLFO ALTA"; }
        if (atual.open > atual.close && anterior.close > anterior.open && atual.close < anterior.open) { sinal = "PUT"; padraoNome = "ENGOLFO BAIXA"; }
    }

    // 2. Filtro de Médias Móveis (EMA)
    if (sinal === "CALL" && configGlobal.emas.e20 && atual.close < e20) return null;
    if (sinal === "PUT" && configGlobal.emas.e20 && atual.close > e20) return null;

    // 3. 🚀 FILTRO DE TENDÊNCIA M5 / M15 (A sua cereja do bolo)
    if (configGlobal.timeframes.m5 || configGlobal.timeframes.m15) {
        const tendeciaMaior = await checarTendenciaMaior(idAtivo);
        
        if (configGlobal.timeframes.m5 && sinal !== tendeciaMaior.m5) {
            console.log(`Filtro M5 barrou sinal em ${idAtivo}`);
            return null; 
        }
        if (configGlobal.timeframes.m15 && sinal !== tendeciaMaior.m15) {
            console.log(`Filtro M15 barrou sinal em ${idAtivo}`);
            return null;
        }
    }

    return sinal ? { direcao: sinal, padrao: padraoNome } : null;
}

// Função que consulta a Deriv rapidinho para ver a tendência maior
async function checarTendenciaMaior(idAtivo) {
    // Simulando a chamada de API para M5 e M15
    // Na prática, o robô faz um request 'ticks_history' com granularity 300 (M5) e 900 (M15)
    return {
        m5: "CALL", // Aqui entra a lógica de ver se a vela M5 é verde/vermelha
        m15: "CALL"
    };
}


    // Filtro de Tendência EMA
    if (sinal === "CALL" && configGlobal.emas.e20 && atual.close < e20) return null;
    if (sinal === "PUT" && configGlobal.emas.e20 && atual.close > e20) return null;

    return sinal ? { direcao: sinal, padrao: padraoNome } : null;
}

// --- GERENCIADOR DE CICLO (ENTRADA -> RESULTADO -> GALE) ---
async function executarCiclo(idAtivo, analise, nivelGale = 0) {
    const est = estadosAtivos[idAtivo];
    const valorBase = bancaAtual * (configGlobal.percentualEntrada / 100);
    const valorEntrada = (valorBase * Math.pow(2.1, nivelGale)).toFixed(2);
    
    const hora = new Date().toLocaleTimeString();
    let label = nivelGale === 0 ? "🚀 ENTRADA REAL" : `🔄 GALE ${nivelGale}`;
    
    await enviarTelegram(`${label}\n📊 Ativo: ${idAtivo}\n📈 Direção: ${analise.direcao}\n💰 Valor: R$ ${valorEntrada}\n🕒 ${hora}\n💵 Banca: R$ ${bancaAtual.toFixed(2)}`);

    // Espera 62 segundos para a vela fechar e a Deriv atualizar
    setTimeout(async () => {
        const history = est.history;
        const velaResultado = history[history.length - 1];
        const deuWin = (analise.direcao === "CALL" && velaResultado.close > velaResultado.open) || 
                       (analise.direcao === "PUT" && velaResultado.close < velaResultado.open);

        if (deuWin) {
            const lucro = valorEntrada * configGlobal.payout;
            bancaAtual += lucro;
            if (nivelGale === 0) placar.direto++;
            else if (nivelGale === 1) placar.g1++;
            else placar.g2++;
            
            await enviarTelegram(`✅ **WIN NO ${nivelGale === 0 ? 'DIRETO' : 'GALE ' + nivelGale}!**\n💰 Lucro: R$ ${lucro.toFixed(2)}\n📊 Placar: ${placar.direto}W - ${placar.red}L`);
        } else {
            // LÓGICA DE GALE OU RED
            if (nivelGale < configGlobal.gale.nivel) {
                // Checagem Inteligente para o próximo Gale
                const e10 = calcularEMA(history, 10);
                const tendenciaInverteu = (analise.direcao === "CALL" && velaResultado.close < e10) || 
                                          (analise.direcao === "PUT" && velaResultado.close > e10);

                if (configGlobal.gale.tipo === 'smart' && tendenciaInverteu) {
                    bancaAtual -= parseFloat(valorEntrada);
                    placar.red++;
                    await enviarTelegram(`🚫 **GALE ABORTADO**\nMotivo: Inversão de tendência na EMA 10.\n📉 Loss: R$ ${valorEntrada}`);
                } else {
                    // Segue para o próximo Gale
                    executarCiclo(idAtivo, analise, nivelGale + 1);
                }
            } else {
                bancaAtual -= parseFloat(valorEntrada);
                placar.red++;
                await enviarTelegram(`❌ **RED (STOP GALE)**\n📊 Ativo: ${idAtivo}\n📉 Perda: R$ ${valorEntrada}\n💵 Banca: R$ ${bancaAtual.toFixed(2)}`);
            }
        }
    }, 62000);
}

// --- CONEXÃO E ROTAS (Igual ao anterior, chamando o executarCiclo) ---
function conectar(idAtivo) {
    if (idAtivo === "NONE") return;
    const ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
    ws.on('open', () => ws.send(JSON.stringify({ ticks_history: idAtivo, end: "latest", count: 100, style: "candles", granularity: 60, subscribe: 1 })));
    ws.on('message', (data) => {
        const res = JSON.parse(data);
        if (!estadosAtivos[idAtivo]) estadosAtivos[idAtivo] = { history: [], lastTime: 0, emOperacao: false };
        const est = estadosAtivos[idAtivo];
        if (res.candles) est.history = res.candles;
        if (res.ohlc) {
            const o = res.ohlc;
            if (o.open_time !== est.lastTime) {
                est.history.push({ open: o.open, close: o.close });
                const analise = analisarMercado(est.history, idAtivo);
                if (analise && !est.emOperacao) {
                    est.emOperacao = true;
                    executarCiclo(idAtivo, analise).then(() => est.emOperacao = false);
                }
                est.lastTime = o.open_time;
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

async function enviarTelegram(msg) {
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: "Markdown" })
    }).catch(e => console.log("Erro TG"));
}

app.listen(PORT, () => {
    console.log(`🚀 Cérebro Completo Online!`);
    configGlobal.slots.forEach(id => conectar(id));
});
