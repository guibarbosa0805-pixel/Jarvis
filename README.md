# Jarvis WhatsApp

Assistente pessoal que conecta no seu WhatsApp (via WhatsApp Web, biblioteca não-oficial [Baileys](https://github.com/WhiskeySockets/Baileys)) e conversa com você dentro do grupo **Jarvis**: cria lembretes de tarefas/reuniões, avisa na hora certa e te dá ideias quando você pedir. O "cérebro" é o Gemini (Google AI).

> Isso usa uma biblioteca não-oficial que automatiza o WhatsApp Web. Não é a API oficial do WhatsApp Business. Use por sua conta e risco (é o método padrão para bots pessoais, mas tecnicamente viola os termos de uso do WhatsApp — risco baixo pra uso pessoal moderado, mas existe).

## 1. Pré-requisitos

- Ter um grupo no WhatsApp chamado **Jarvis** com você (pode ser só você nele).
- Uma chave de API do Gemini: crie em https://aistudio.google.com/apikey (gratuito, com limites de uso).

## 2. Configurar

1. Abra o arquivo [.env](.env) e cole sua chave:
   ```
   GEMINI_API_KEY=sua_chave_aqui
   ```
2. Se o seu grupo tiver outro nome (não "Jarvis"), ajuste `GROUP_NAME` no mesmo arquivo.

## 3. Rodar

```bash
npm start
```

Na primeira vez vai aparecer um **QR code no terminal**. No celular: WhatsApp > Configurações > Aparelhos conectados > Conectar um aparelho, e escaneie. Depois disso a sessão fica salva na pasta `auth/` e não precisa escanear de novo (a não ser que desconecte o aparelho pelo celular).

Deixe o terminal/PC rodando — o bot só funciona enquanto o processo `npm start` estiver ativo.

## 4. Como usar

Fale naturalmente no grupo Jarvis, por exemplo:

- `me lembra de ligar pro cliente hoje às 17h` → ele cria o lembrete e avisa no grupo na hora.
- `tenho reunião com o time quinta às 10h, pauta: revisão do projeto` → cria o lembrete com os detalhes.
- `o que eu tenho pendente?` → lista as tarefas/lembretes em aberto.
- `terminei a tarefa de ligar pro cliente` → marca como concluída.
- `cancela o lembrete da reunião de quinta` → remove.
- `me dá 5 ideias pra organizar o lançamento do produto` → ele responde direto com sugestões, sem precisar criar nada.

Os lembretes são checados a cada minuto; quando chega a hora, o Jarvis manda a mensagem de aviso no grupo sozinho.

## 5. Dados

- `auth/` — sessão do WhatsApp (não apague, a não ser que queira reconectar do zero).
- `data/tasks.json` — suas tarefas/lembretes (criado automaticamente).

Nenhum dado sai da sua máquina, exceto o texto das mensagens enviado ao Gemini para gerar as respostas.

## 6. Problemas comuns

- **Desconectou / parou de responder**: o terminal mostra o motivo. Se disser "sessão desconectada", apague a pasta `auth/` e rode `npm start` de novo para gerar um novo QR code.
- **"Grupo não encontrado"**: o nome em `GROUP_NAME` precisa ser **idêntico** ao nome do grupo no WhatsApp, incluindo emojis (ex: `Jarvis🧠` ≠ `Jarvis`). O log mostra a lista de grupos encontrados se não bater.

## 7. Dar isso pra outra pessoa usar

Cada pessoa precisa da sua **própria cópia rodando** (seu próprio PC, sua própria sessão de WhatsApp, sua própria chave Gemini) — não dá pra uma instância só atender várias contas de WhatsApp ao mesmo tempo. Pra replicar:

1. Copie a pasta do projeto (sem as pastas `auth/`, `data/` e sem o arquivo `.env` — cada pessoa cria os seus).
2. A pessoa roda `npm install`, cria o grupo no WhatsApp dela (qualquer nome), copia `.env.example` para `.env` e preenche `GEMINI_API_KEY` e `GROUP_NAME` com o nome exato do grupo dela.
3. `npm start` e ela escaneia o QR code com o próprio celular.

Como cada cópia roda isolada (processo, sessão de WhatsApp e `tasks.json` separados), não existe risco de misturar tarefas ou conversas entre pessoas diferentes.
