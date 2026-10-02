// Roda o content_script.js REAL num contexto vm com chrome/webkitSpeechRecognition falsos.
// Rodar com: node --test 'tests/js/*.test.mjs'
// CONTENT_SCRIPT=<caminho> permite rodar os mesmos testes contra outra versão do arquivo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const arquivo = process.env.CONTENT_SCRIPT
  || path.join(aqui, '../../extension/scripts/content_script.js');
const codigo = fs.readFileSync(arquivo, 'utf8');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function carregar() {
  const enviadas = [];
  let ouvinte = null;
  let reconhecimento = null;
  const chamadas = { start: 0, stop: 0, abort: 0 };

  class FakeRecognition {
    constructor() { reconhecimento = this; }
    start() { chamadas.start++; }
    stop() { chamadas.stop++; }
    abort() { chamadas.abort++; }
  }

  const contexto = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearInterval,
    setInterval: () => 0, // sem polling nos testes
    sessionStorage: { getItem: () => null },
    document: { addEventListener() {} },
    webkitSpeechRecognition: FakeRecognition,
    chrome: {
      storage: { local: { get() {}, set() {} } },
      runtime: {
        onMessage: { addListener: (fn) => { ouvinte = fn; } },
        sendMessage: (msg) => { enviadas.push(msg); return Promise.resolve(); },
      },
    },
  };
  contexto.window = contexto;
  vm.createContext(contexto);
  vm.runInContext(codigo, contexto, { filename: arquivo });

  const enviar = (action) => {
    let resposta;
    ouvinte({ action }, {}, (r) => { resposta = r; });
    return resposta;
  };
  // Emite um resultado final do reconhecimento de voz
  const falar = (texto) => {
    reconhecimento.onresult?.({
      resultIndex: 0,
      results: [Object.assign([{ transcript: texto }], { isFinal: true })],
    });
  };
  const ultimoTexto = () => enviadas.filter((m) => m.action === 'UPDATE_TRANSCRIPT').at(-1)?.text;

  return { enviar, falar, ultimoTexto, enviadas, chamadas, reconhecimento: () => reconhecimento };
}

test('primeira gravação transcreve', async () => {
  const s = carregar();
  s.enviar('START_RECORDING');
  await esperar(150);
  assert.equal(s.chamadas.start, 1);
  s.falar('dor de cabeça');
  assert.equal(s.ultimoTexto(), 'dor de cabeça ');
});

test('gravar de novo depois de parar volta a transcrever (regressão do onresult = null)', async () => {
  const s = carregar();

  s.enviar('START_RECORDING');
  await esperar(150);
  s.falar('primeira consulta');
  assert.equal(s.ultimoTexto(), 'primeira consulta ');
  s.enviar('STOP_RECORDING');

  s.enviar('START_RECORDING');
  await esperar(150);
  s.falar('segunda consulta');
  assert.equal(s.ultimoTexto(), 'segunda consulta ', 'a 2ª gravação deveria transcrever só a fala nova');
});

test('áudio que chega depois de parar é ignorado', async () => {
  const s = carregar();
  s.enviar('START_RECORDING');
  await esperar(150);
  s.falar('antes');
  s.enviar('STOP_RECORDING');
  const antes = s.enviadas.length;
  s.falar('residual');
  assert.equal(s.enviadas.length, antes, 'nenhuma mensagem nova após STOP');
});

test('CANCEL_RECORDING aborta o microfone, zera o acumulado e ignora áudio residual', async () => {
  const s = carregar();
  s.enviar('START_RECORDING');
  await esperar(150);
  s.falar('atendimento A');
  const abortsAntes = s.chamadas.abort;

  const resposta = s.enviar('CANCEL_RECORDING');
  assert.equal(resposta?.status, 'cancelled'); // (objeto do vm tem outro protótipo: não usar deepEqual)
  assert.ok(s.chamadas.abort > abortsAntes, 'abort() deve ser chamado');

  const antes = s.enviadas.length;
  s.falar('residual do A');
  assert.equal(s.enviadas.length, antes, 'áudio após o cancelamento é ignorado');

  // nova gravação (outro atendimento) não herda o texto do A
  s.enviar('START_RECORDING');
  await esperar(150);
  s.falar('atendimento B');
  assert.equal(s.ultimoTexto(), 'atendimento B ');
  assert.ok(!s.ultimoTexto().includes('A'), 'sem resquício do atendimento anterior');
});
