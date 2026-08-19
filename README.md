# 🩺 Copiloto Acesso Saúde CE

Assistente virtual inteligente em formato de Extensão do Google Chrome, desenvolvido para atuar integrado ao **Acesso Saúde CE** — plataforma oficial de Telessaúde da Secretaria da Saúde do Estado do Ceará (SESA-CE).

A ferramenta utiliza um motor de alta performance compilado em **WebAssembly (Rust)** para ler, sanitizar e resumir o histórico clínico dos pacientes em tempo real, fornecendo um chat interativo para apoio à decisão médica durante as teleconsultas.

---

## 🎯 Visão Geral & Roadmap

### 🚀 Fase 1 (MVP Atual)

* **Extração & Sanitização Local:** Leitura automática do histórico médico visível na tela do Acesso Saúde CE com higienização de dados em memória local (foco em conformidade com a LGPD).
* **Resumo Clínico Automatizado:** Geração instantânea de um resumo do histórico do paciente enviado diretamente para o contexto do chat.
* **Chat Interativo:** Interface conversacional em estilo side-panel para o médico tirar dúvidas, consultar alergias, hábitos, condutas anteriores e prescrições pregressas.

### 🔮 Fases Futuras

* **Validação de OCIs:** Triagem automática para Ofertas de Cuidados Integrados (Cardiologia, Oncologia, Diabetes, etc.).
* **Expansão Multimodular:** Integração completa em todos os módulos da plataforma Acesso Saúde CE (Agendamento, Prontuário, Documentos médicos, etc...).

---

## 🏗️ Arquitetura da Solução

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           NAVEGADOR CHROME                              │
│                                                                         │
│  [ Plataforma Acesso Saúde CE ]                                         │
│                 │                                                       │
│                 ▼                                                       │
│        [ Content Script ] ──(Captura DOM/Histórico)                     │
│                 │                                                       │
│                 ▼                                                       │
│   ┌──────────────────────────┐                                          │
│   │   Engine Rust (Wasm)     │                                          │
│   ├──────────────────────────┤                                          │
│   │ • Parsing de Prontuário  │                                          │
│   │ • Estruturação de Dados  │                                          │
│   │ • Gestão de Contexto     │                                          │
│   └──────────────────────────┘                                          │
│                 │                                                       │
│                 ▼                                                       │
│   [ Interface Chat / Copiloto ] ──► Interação do Médico                 │
└─────────────────────────────────────────────────────────────────────────┘

```

---

## 🛠️ Tecnologias Utilizadas

* **Linguagem Core:** [Rust](https://www.rust-lang.org/) (Segurança de memória e alta performance)
* **Target de Compilação:** WebAssembly (`wasm32-unknown-unknown`)
* **Ponte JS/Rust:** `wasm-bindgen` + `serde-wasm-bindgen`
* **Build Tool:** `wasm-pack`
* **Extensão:** Google Chrome Manifest V3 (Content Scripts & Side Panel)

---


## 💻 Pré-requisitos para Desenvolvimento

Antes de começar, certifique-se de ter instalado em sua máquina:

1. **Rust Toolchain:** [Instalar o Rust](https://www.rust-lang.org/tools/install)
2. **Target Wasm:**
```bash
rustup target add wasm32-unknown-unknown

```


3. **wasm-pack:**
```bash
cargo install wasm-pack

```


4. **Navegador:** Google Chrome (ou qualquer navegador baseado em Chromium).

---

## ⚙️ Compilação e Build

Siga os passos abaixo para compilar o código Rust em WebAssembly:

1. **Clone o repositório:**
```bash
git clone https://github.com/seu-usuario/acesso-saude-copilot.git
cd acesso-saude-copilot

```


2. **Compile o projeto Rust para Wasm:**
```bash
wasm-pack build --target web --release

```


> Esse comando cria a pasta `/pkg` contendo o arquivo `.wasm` compilado e as pontes de integração JavaScript.



---

## 🔌 Instalação da Extensão no Google Chrome

Para testar a extensão em ambiente de desenvolvimento local:

1. Abra o **Google Chrome**.
2. Cole o seguinte endereço na barra de navegação e pressione `Enter`:
```text
chrome://extensions/

```


3. No canto superior direito, ative a chave **Modo do desenvolvedor** (*Developer mode*).
4. No canto superior esquerdo, clique no botão **Carregar sem compactação** (*Load unpacked*).
5. Selecione a **pasta raiz do projeto** (onde se encontra o arquivo `manifest.json`).
6. A extensão **Copiloto Acesso Saúde CE** aparecerá na sua lista de extensões ativas.

---

## 🔒 Segurança e Privacidade (LGPD)

Como a extensão processa dados sensíveis de saúde da população do Ceará, a arquitetura adota as seguintes premissas de segurança:

* **Processamento In-Memory:** O parsing, a higienização de dados pessoais (PII) e o enquadramento estruturado do histórico ocorrem inteiramente dentro do binário WebAssembly na memória RAM local do navegador.
* **Sem Armazenamento Externo:** Nenhum dado de prontuário é persistido em bancos de dados não autorizados.
