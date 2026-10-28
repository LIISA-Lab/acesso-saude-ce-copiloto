// Roda o content_script.js REAL (com o motor stt_engine.js) num contexto vm com
// chrome/webkitSpeechRecognition falsos. Rodar com: node --test 'tests/js/*.test.mjs'
// CONTENT_SCRIPT=<caminho> permite rodar os mesmos testes contra outra versão do arquivo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { carregar } from './harness-stt.mjs';

test('primeira gravação transcreve', async () => {
  const s = carregar();
  await s.iniciar();
  assert.equal(s.chamadas.start, 1);
  s.falar('dor de cabeça');
  assert.equal(s.ultimoTexto(), 'dor de cabeça ');
});

test('gravar de novo depois de parar volta a transcrever (regressão do onresult = null)', async () => {
  const s = carregar();

  await s.iniciar();
  s.falar('primeira consulta');
  assert.equal(s.ultimoTexto(), 'primeira consulta ');
  const parada = s.enviar('STOP_RECORDING');
  s.terminar(); // o Chrome dispara onend depois do stop()
  await parada;

  await s.iniciar();
  s.falar('segunda consulta');
  assert.equal(s.ultimoTexto(), 'segunda consulta ', 'a 2ª gravação deveria transcrever só a fala nova');
});

test('áudio que chega depois de parar é ignorado', async () => {
  const s = carregar();
  await s.iniciar();
  s.falar('antes');
  const parada = s.enviar('STOP_RECORDING');
  s.terminar();
  await parada;
  const antes = s.enviadas.length;
  s.falar('residual');
  assert.equal(s.enviadas.length, antes, 'nenhuma mensagem nova após o fim da parada');
});

test('CANCEL_RECORDING aborta o microfone, zera o acumulado e ignora áudio residual', async () => {
  const s = carregar();
  await s.iniciar();
  s.falar('atendimento A');
  const abortsAntes = s.chamadas.abort;

  const resposta = await s.enviar('CANCEL_RECORDING');
  assert.equal(resposta?.status, 'cancelled'); // (objeto do vm tem outro protótipo: não usar deepEqual)
  assert.ok(s.chamadas.abort > abortsAntes, 'abort() deve ser chamado');

  const antes = s.textos().length;
  s.falar('residual do A');
  assert.equal(s.textos().length, antes, 'áudio após o cancelamento é ignorado');

  // nova gravação (outro atendimento) não herda o texto do A
  await s.iniciar();
  s.falar('atendimento B');
  assert.equal(s.ultimoTexto(), 'atendimento B ');
  assert.ok(!s.ultimoTexto().includes('A'), 'sem resquício do atendimento anterior');
});
