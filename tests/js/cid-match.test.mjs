// Escolha da opção do campo de CID (extension/scripts/cid_match.js), carregada como o painel
// a injeta: um script clássico que publica `globalThis.__copilotoCid`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const arquivo = path.join(aqui, '../../extension/scripts/cid_match.js');
const contexto = {};
contexto.globalThis = contexto;
vm.createContext(contexto);
vm.runInContext(fs.readFileSync(arquivo, 'utf8'), contexto, { filename: arquivo });
const { escolher, analisar } = contexto.__copilotoCid;

// Rótulos ilustrativos no estilo da lista do sistema (a busca por "enxaqueca" devolve 6 opções,
// uma delas "Enxaqueca" e uma "Enxaqueca sem Especificação").
const ENXAQUECA = [
  'G43 - Enxaqueca',
  'G43.0 - Enxaqueca sem aura',
  'G43.1 - Enxaqueca com aura',
  'G43.3 - Enxaqueca complicada',
  'G43.8 - Outras formas de enxaqueca',
  'G43.9 - Enxaqueca sem Especificação',
];

test('"não especificada" casa com "sem Especificação" (o caso da enxaqueca)', () => {
  const i = escolher(ENXAQUECA, 'Enxaqueca', 'Enxaqueca, não especificada');
  assert.equal(ENXAQUECA[i], 'G43.9 - Enxaqueca sem Especificação');
});

test('sem a marca de "não especificado" prefere a opção genérica', () => {
  assert.equal(ENXAQUECA[escolher(ENXAQUECA, 'Enxaqueca', 'Enxaqueca')], 'G43 - Enxaqueca');
});

test('com aura e sem aura não se confundem', () => {
  assert.equal(ENXAQUECA[escolher(ENXAQUECA, 'Enxaqueca', 'Enxaqueca com aura')], 'G43.1 - Enxaqueca com aura');
  assert.equal(ENXAQUECA[escolher(ENXAQUECA, 'Enxaqueca', 'Enxaqueca sem aura')], 'G43.0 - Enxaqueca sem aura');
  // só existe "sem aura": para "com aura" não pode escolher nada
  assert.equal(escolher(['G43.0 - Enxaqueca sem aura'], 'Enxaqueca', 'Enxaqueca com aura'), -1);
});

test('variações de "não especificado" são o mesmo marcador', () => {
  for (const t of ['Enxaqueca, não especificada', 'Enxaqueca sem especificação', 'Enxaqueca sem outra especificação', 'ENXAQUECA NAO ESPECIFICADA']) {
    assert.equal(analisar(t).naoEspecificado, true, t);
  }
  for (const t of ['Enxaqueca', 'Enxaqueca sem aura', 'Outras formas de enxaqueca']) {
    assert.equal(analisar(t).naoEspecificado, false, t);
  }
});

test('números diferentes vetam: tipo 1 não vira tipo 2, nem o genérico vira tipo 2', () => {
  const dm = ['E10 - Diabetes mellitus tipo 1', 'E11 - Diabetes mellitus tipo 2'];
  assert.equal(escolher(dm, 'Diabetes', 'Diabetes mellitus tipo 1'), 0);
  assert.equal(escolher(dm, 'Diabetes', 'Diabetes mellitus tipo 2'), 1);
  assert.equal(escolher(['E11 - Diabetes mellitus tipo 2'], 'Diabetes', 'Diabetes mellitus tipo 1'), -1);
  assert.equal(escolher(dm, 'Diabetes', 'Diabetes mellitus'), -1, 'sem número no diagnóstico, não escolhe um subtipo');
  assert.equal(escolher([...dm, 'E14 - Diabetes mellitus não especificado'], 'Diabetes', 'Diabetes mellitus'), 2);
});

test('radical: "infecção das vias aéreas" casa com o nome oficial, e Cólera não casa com nada', () => {
  const lista = ['A00 - Cólera', 'J06.9 - Infecção aguda das vias aéreas superiores, não especificada'];
  assert.equal(escolher(lista, 'Infecção das vias aéreas', 'infecção das vias aéreas superiores não especificada'), 1);
  assert.equal(escolher(['A00 - Cólera'], 'Enxaqueca', 'Enxaqueca'), -1);
});

test('cobertura abaixo de 75% não seleciona', () => {
  // só "hipertensão" coincide: 1 de 2 palavras
  assert.equal(escolher(['I10 - Hipertensão essencial (primária)'], 'Hipertensão', 'Hipertensão arterial'), -1);
  // 4 de 5 palavras (falta "aguda") passa
  assert.equal(escolher(['J06 - Infecção das vias aéreas superiores'], 'Infecção', 'Infecção aguda das vias aéreas superiores'), 0);
});

test('código citado manda, mesmo com o nome diferente', () => {
  const lista = ['A00 - Cólera', 'J06.9 - Infecção aguda das vias aéreas superiores, não especificada'];
  assert.equal(escolher(lista, 'J06.9', 'J06.9 resfriado'), 1);
});

test('entradas vazias ou só com palavras vazias devolvem -1', () => {
  assert.equal(escolher(ENXAQUECA, '', ''), -1);
  assert.equal(escolher(ENXAQUECA, 'de da', 'de da'), -1);
  assert.equal(escolher([], 'Enxaqueca', 'Enxaqueca'), -1);
});

test('diagnóstico genérico não vira subtipo: "Pneumonia" prefere a variante não especificada', () => {
  const pneumonia = [
    'J15 - Pneumonia bacteriana não classificada em outra parte',
    'J18 - Pneumonia por microorganismo não especificado',
    'J18.9 - Pneumonia não especificada',
  ];
  // com a opção mais genérica disponível, é ela
  assert.equal(pneumonia[escolher(pneumonia, 'Pneumonia', 'Pneumonia')], 'J18.9 - Pneumonia não especificada');
  // sem ela, a que tem menos palavras a mais, e nunca a "bacteriana"
  assert.equal(pneumonia[escolher(pneumonia.slice(0, 2), 'Pneumonia', 'Pneumonia')], 'J18 - Pneumonia por microorganismo não especificado');
  // e se o diagnóstico já diz "não especificada", o resultado é o mesmo
  assert.equal(pneumonia[escolher(pneumonia, 'Pneumonia', 'Pneumonia, não especificada')], 'J18.9 - Pneumonia não especificada');
  // quem diz "bacteriana" continua recebendo a bacteriana
  assert.equal(pneumonia[escolher(pneumonia, 'Pneumonia', 'Pneumonia bacteriana')], 'J15 - Pneumonia bacteriana não classificada em outra parte');
});
