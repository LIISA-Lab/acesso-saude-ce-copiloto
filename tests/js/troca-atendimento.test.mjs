// Rodar com: node --test 'tests/js/*.test.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import { criarDetectorDeTroca } from '../../extension/ui/troca-atendimento.js';

test('primeiro id visto não é troca (nada para reiniciar)', () => {
  const mudou = criarDetectorDeTroca();
  assert.equal(mudou(undefined, 'A'), false);
});

test('mesmo id repetido não é troca', () => {
  const mudou = criarDetectorDeTroca();
  mudou(undefined, 'A');
  assert.equal(mudou('A', 'A'), false);
  assert.equal(mudou('A', 'A'), false);
});

test('A -> B é troca', () => {
  const mudou = criarDetectorDeTroca();
  mudou(undefined, 'A');
  assert.equal(mudou('A', 'B'), true);
});

test('painel aberto com A já no storage: primeira mudança A -> B é troca', () => {
  // o painel nunca viu A; o oldValue do storage inicializa o estado
  const mudou = criarDetectorDeTroca();
  assert.equal(mudou('A', 'B'), true);
});

test('leitura transitória vazia não reinicia e não perde o id', () => {
  const mudou = criarDetectorDeTroca();
  mudou(undefined, 'A');
  for (const vazio of [null, undefined, '']) {
    assert.equal(mudou('A', vazio), false, `vazio=${JSON.stringify(vazio)}`);
  }
  assert.equal(mudou(null, 'A'), false, 'A -> vazio -> A continua sendo o mesmo atendimento');
});

test('A -> vazio -> B ainda é troca', () => {
  const mudou = criarDetectorDeTroca();
  mudou(undefined, 'A');
  mudou('A', null);
  assert.equal(mudou(null, 'B'), true);
});

test('B -> A depois de A -> B também é troca', () => {
  const mudou = criarDetectorDeTroca();
  mudou(undefined, 'A');
  assert.equal(mudou('A', 'B'), true);
  assert.equal(mudou('B', 'A'), true);
});

test('detectores são independentes entre si', () => {
  const x = criarDetectorDeTroca();
  const y = criarDetectorDeTroca();
  x(undefined, 'A');
  assert.equal(y(undefined, 'B'), false);
});
