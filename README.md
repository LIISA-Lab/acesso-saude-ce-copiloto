# Acesso Saúde CE — Copiloto

Extensão de navegador, escrita em Rust e compilada para WebAssembly, que atua como um copiloto de IA para o Acesso Saúde CE, auxiliando médicos no fluxo de prescrição durante o uso da aplicação.

## Stack

- **Rust** — linguagem principal, gerenciada via [Cargo](https://doc.rust-lang.org/cargo/)
- **WebAssembly** (`wasm32-unknown-unknown`) — alvo de compilação
- **[wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen)** — interoperabilidade entre Rust/Wasm e JavaScript
- **[wasm-pack](https://github.com/wasm-bindgen/wasm-pack)** — build e empacotamento do módulo Wasm
- **WebExtension (Manifest V3)** — empacotamento como extensão de navegador (Chrome/Edge/Firefox)

## Pré-requisitos

1. **Rust** via [rustup](https://rustup.rs/):

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. **Target Wasm**:

   ```bash
   rustup target add wasm32-unknown-unknown
   ```

3. **wasm-pack**:

   ```bash
   cargo install wasm-pack
   ```

4. Navegador baseado em Chromium (Chrome/Edge) ou Firefox, para carregar a extensão em modo desenvolvedor.

## Configuração do ambiente

Verifique se as ferramentas foram instaladas corretamente:

```bash
rustc --version
cargo --version
wasm-pack --version
rustup target list --installed | grep wasm32-unknown-unknown
```

## Build

```bash
cargo build
```

Build do módulo Wasm (quando a estrutura do crate estiver definida):

```bash
wasm-pack build --target web
```

## Carregando a extensão para desenvolvimento

1. Gere o build (`wasm-pack build`).
2. No navegador, acesse a página de extensões (`chrome://extensions` ou `about:debugging#/runtime/this-firefox`).
3. Ative o "Modo desenvolvedor" e carregue a extensão descompactada apontando para o diretório de build/manifest.

> Detalhes do `manifest.json` e da estrutura de background/content scripts serão adicionados conforme o projeto evoluir.

## Estrutura do projeto

Ainda em definição. A estrutura de crate(s), diretório de assets da extensão e organização de scripts (background/content/popup) será documentada aqui assim que estabilizar.

## Contribuindo

Projeto interno em desenvolvimento inicial — convenções de contribuição serão definidas em breve.
