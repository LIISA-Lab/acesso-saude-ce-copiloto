// Escolha da opção do campo de CID (MUI Autocomplete) que corresponde a um diagnóstico.
//
// O campo filtra as opções por trecho do nome, então o painel digita um termo curto
// (`busca`) e aqui se escolhe, entre as opções devolvidas, a que melhor corresponde ao
// nome completo do diagnóstico (`nome`). Sem correspondência clara devolve -1: o campo
// fica vazio para o médico escolher, e nunca se cai numa opção qualquer.
//
// Injetado no mundo MAIN da página (chrome.scripting.executeScript) antes do
// preenchimento; não depende de `chrome.*` nem do DOM, o que permite testar com `vm`.
(function () {
  const COBERTURA_MINIMA = 0.75; // fração das palavras do diagnóstico que a opção precisa ter
  const TAMANHO_RADICAL = 6;     // `especificada`/`especificação`, `infecção`/`infecciosa`
  // "com" e "sem" ficam: "enxaqueca com aura" e "enxaqueca sem aura" são diagnósticos diferentes.
  const PALAVRAS_VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'as', 'os', 'em', 'na', 'no', 'nas', 'nos', 'ou', 'por', 'para']);

  const REGEX_CODIGO = /\b[a-z]\d{2}(?:\.\d+)?\b/g;
  // "não especificada", "sem especificação", "sem outra especificação" dizem a mesma coisa
  const REGEX_NAO_ESPECIFICADO = /\b(?:nao|sem)\s+(?:outras?\s+)?especifica\w*/g;

  function normalizar(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }

  function extrairCodigos(s) {
    return normalizar(s).match(REGEX_CODIGO) || [];
  }

  function radical(p) {
    return p.length > TAMANHO_RADICAL ? p.slice(0, TAMANHO_RADICAL) : p;
  }

  // Quebra o texto em: núcleo (radicais das palavras), números, e se diz "não especificado"
  function analisar(texto) {
    let norm = normalizar(texto).replace(REGEX_CODIGO, ' ');
    const naoEspecificado = REGEX_NAO_ESPECIFICADO.test(norm);
    REGEX_NAO_ESPECIFICADO.lastIndex = 0;
    norm = norm.replace(REGEX_NAO_ESPECIFICADO, ' ');

    const tokens = norm.split(/[^a-z0-9]+/).filter(Boolean);
    const numeros = new Set(tokens.filter((t) => /^\d+$/.test(t)));
    const nucleo = new Set(
      tokens.filter((t) => !/^\d+$/.test(t) && !PALAVRAS_VAZIAS.has(t)).map(radical),
    );
    return { nucleo, numeros, naoEspecificado, texto: tokens.join(' ') };
  }

  function trigramas(s) {
    const t = ' ' + s + ' ';
    const r = new Set();
    for (let i = 0; i + 3 <= t.length; i++) r.add(t.slice(i, i + 3));
    return r;
  }

  // Coeficiente de Dice entre trigramas de caracteres (0 a 1). Só desempata: texto parecido
  // não basta para aceitar, porque "tipo 1" e "tipo 2" são quase idênticos.
  function similaridade(a, b) {
    const ta = trigramas(a);
    const tb = trigramas(b);
    let comuns = 0;
    ta.forEach((g) => { if (tb.has(g)) comuns++; });
    return ta.size + tb.size === 0 ? 0 : (2 * comuns) / (ta.size + tb.size);
  }

  // Nota de uma opção para o diagnóstico, ou null se não serve
  function pontuar(textoOpcao, alvo) {
    const opcao = analisar(textoOpcao);

    // Números (tipo 1/2, grau...) mudam o diagnóstico: têm de coincidir nos dois sentidos
    for (const n of alvo.numeros) if (!opcao.numeros.has(n)) return null;
    for (const n of opcao.numeros) if (!alvo.numeros.has(n)) return null;

    let comuns = 0;
    alvo.nucleo.forEach((p) => { if (opcao.nucleo.has(p)) comuns++; });
    const cobertura = comuns / alvo.nucleo.size;
    if (cobertura < COBERTURA_MINIMA) return null;

    let extras = 0;
    opcao.nucleo.forEach((p) => { if (!alvo.nucleo.has(p)) extras++; });

    return {
      cobertura,
      mesmoMarcador: opcao.naoEspecificado === alvo.naoEspecificado,
      extras,
      similaridade: similaridade(alvo.texto, opcao.texto),
    };
  }

  // Devolve o índice da melhor opção em `textos`, ou -1.
  function escolher(textos, busca, nome) {
    const alvoTexto = String(nome || busca || '');

    // Código citado: manda
    const codigos = extrairCodigos(alvoTexto + ' ' + (busca || ''));
    if (codigos.length) {
      const i = textos.findIndex((t) => extrairCodigos(t).some((c) => codigos.includes(c)));
      if (i >= 0) return i;
    }

    let alvo = analisar(alvoTexto);
    if (alvo.nucleo.size === 0) alvo = analisar(busca);
    if (alvo.nucleo.size === 0) return -1;

    let melhor = -1;
    let melhorNota = null;
    textos.forEach((t, i) => {
      const nota = pontuar(t, alvo);
      if (!nota) return;
      if (!melhorNota || compararNotas(nota, melhorNota) < 0) {
        melhor = i;
        melhorNota = nota;
      }
    });
    return melhor;
  }

  // Menor é melhor: mais cobertura, mesmo "não especificado", menos palavras a mais, mais parecido
  function compararNotas(a, b) {
    if (a.cobertura !== b.cobertura) return b.cobertura - a.cobertura;
    if (a.mesmoMarcador !== b.mesmoMarcador) return a.mesmoMarcador ? -1 : 1;
    if (a.extras !== b.extras) return a.extras - b.extras;
    return b.similaridade - a.similaridade;
  }

  globalThis.__copilotoCid = { escolher, analisar };
})();
