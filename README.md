# Jarvis WhatsApp

Assistente pessoal (secretário) que conecta no WhatsApp (via WhatsApp Web, biblioteca não-oficial [Baileys](https://github.com/WhiskeySockets/Baileys)) e conversa numa conversa dedicada: cria lembretes de tarefas/reuniões (com link, se houver), avisa com antecedência e na hora exata, manda um resumo da agenda pela manhã, e dá ideias quando pedido. O "cérebro" é o Gemini (Google AI).

Roda como **múltiplas instâncias independentes na mesma máquina**: cada pessoa conecta o próprio celular (via QR code) a uma instância só dela, com grupo, histórico de conversa e lista de tarefas totalmente isolados das outras. A máquina (e a chave de API do Gemini) é compartilhada; os dados e sessões de WhatsApp, não.

> Isso usa uma biblioteca não-oficial que automatiza o WhatsApp Web. Não é a API oficial do WhatsApp Business. Use por sua conta e risco (é o método padrão para bots pessoais, mas tecnicamente viola os termos de uso do WhatsApp — risco baixo pra uso pessoal moderado, mas existe).
>
> **Transparência pra quem for conectar o celular:** as mensagens de cada pessoa passam pela chave de Gemini de quem administra a máquina (consumo/billing aparece pra ela) e ficam salvas em texto puro no disco dessa máquina (`data/<instância>.json`). Só conecte gente que tope isso.

## 1. Pré-requisitos

- Uma chave de API do Gemini: crie em https://aistudio.google.com/apikey (gratuito, com limites de uso). Pode ser uma só, compartilhada entre todas as instâncias.
- Node.js instalado na máquina que vai rodar tudo.

## 2. Painel de controle (recomendado)

```bash
npm run panel
```

Abre um painel web em **http://localhost:4545** (só acessível desta máquina). Nele dá pra:

- **Adicionar pessoa**: formulário com nome, nome de exibição, chave Gemini (já vem preenchida com a mesma chave de quem já existe), telefone opcional (pra usar código de pareamento em vez de QR) e grupo do WhatsApp **opcional** — se deixar vazio, usa a conversa "Mensagens para você mesmo" dela, sem precisar criar grupo nenhum.
- Ver o **QR code ou código de pareamento na tela**, ao vivo, assim que a instância sobe.
- **Iniciar/Parar** cada instância individualmente, ou todas de uma vez ("Iniciar todas").
- Ver **logs** de cada uma em tempo real.
- **Remover** uma instância (mantém a sessão do WhatsApp salva, caso queira recriar com o mesmo nome depois sem reparear).

Deixe esse processo rodando (`npm run panel`) — ele mantém as instâncias vivas enquanto estiver ativo. Se preferir não usar o painel, dá pra fazer tudo manualmente (próxima seção).

## 3. Alternativa: linha de comando

1. Decida: ela vai falar com o Jarvis num **grupo** dedicado (com qualquer nome) ou na própria conversa **"Mensagens para você mesmo"** (não precisa criar nada)?
2. Copie `instances/example.env` para `instances/<nome-da-pessoa>.env` (ex: `instances/maria.env`) e preencha:
   ```
   GEMINI_API_KEY=sua_chave_aqui
   GEMINI_MODEL=gemini-2.5-flash
   DISPLAY_NAME=Maria
   GROUP_NAME=nome_exato_do_grupo_dela   # deixe vazio para usar "Mensagens para você mesmo"
   DIGEST_TIME=07:30                      # horário do resumo matinal; vazio = sem resumo
   ```
3. Rode essa instância sozinha pela primeira vez, pra fazer o pareamento:
   ```bash
   node src/index.js <nome-da-pessoa>
   ```
4. Pareie o celular dela — duas formas, sem precisar estar perto da máquina que roda o bot:
   - **QR code** (padrão, se `PHONE_NUMBER` não estiver no `.env` dela): aparece no terminal, e também salvo como imagem em `qr-<nome-da-pessoa>.png`. Ela escaneia em WhatsApp > Configurações > Aparelhos conectados > Conectar um aparelho.
   - **Código de pareamento, sem QR** (defina `PHONE_NUMBER=5511999999999` — só dígitos, com DDI — no `.env` dela antes de rodar): o terminal mostra um código tipo `ABCD-1234`. Você manda esse código por texto pra ela (WhatsApp, SMS, o que for), e ela digita em WhatsApp > Configurações > Aparelhos conectados > Conectar um aparelho > "Conectar com número de telefone". Mais prático quando ela não está do seu lado.
5. Depois de conectar, pode parar esse processo (Ctrl+C) e subir todo mundo junto — a sessão fica salva em `auth/<nome-da-pessoa>/` e não precisa parear de novo (a não ser que a pessoa desconecte o aparelho pelo próprio celular).

```bash
npm run start:all
```

Sobe um processo para cada instância configurada em `instances/*.env` ao mesmo tempo. Os logs de todas aparecem juntos no mesmo terminal, prefixados com `[jarvis:<nome>]`. Pra rodar só uma pessoa: `node src/index.js <nome-da-pessoa>`.

Em ambos os casos, deixe o processo rodando — o bot só funciona enquanto estiver ativo.

## 4. Como usar

Cada pessoa fala naturalmente na própria conversa (grupo ou "Mensagens para você mesmo"), por exemplo:

- `masterclass sobre dados hoje às 19:30 https://link-do-evento` → cria o lembrete, extrai o link sozinho e confirma:
  ```
  ✅ Agendado, Guilherme!

  📅 masterclass sobre dados
  📆 07/10 às 19:30
  ⏰ Lembrete: 19:00
  🔗 Link: https://link-do-evento

  Fico de olho pra te lembrar! 😉
  ```
- `tenho reunião com o time quinta às 10h, pauta: revisão do projeto` → cria o lembrete com os detalhes.
- `o que eu tenho pendente?` → lista as tarefas/lembretes em aberto.
- `terminei a tarefa de ligar pro cliente` → marca como concluída.
- `cancela o lembrete da reunião de quinta` → remove.
- `me dá 5 ideias pra organizar o lançamento do produto` → responde direto com sugestões, sem precisar criar nada.

Pra cada compromisso com horário, o Jarvis manda **dois** avisos automáticos (checados a cada minuto), sempre prefixados com "🤖 *Jarvis:*" (pra diferenciar das suas próprias mensagens, já que o bot usa a mesma conta/WhatsApp):

- **Com antecedência** (30 min antes por padrão — dá pra pedir outro valor, ex: "me avisa 1h antes"):
  ```
  ⏰ Lembrete: faltam 30 min!

  📅 masterclass sobre dados
  📆 07/10 às 19:30
  🔗 Link: https://link-do-evento
  ```
- **Na hora exata**:
  ```
  Lembrete, AGORA!:
  masterclass sobre dados

  Data e hora:
  📅 07/10/2026 19:30
  ```

Se `DIGEST_TIME` estiver configurado, todo dia nesse horário o Jarvis manda um resumo da agenda do dia (só se houver algo marcado):
```
Oii Guilherme 😊, tudo bem?

Agendamento(s) de hoje:

📅 09:00 - Visita Vonex
📅 11:00 - Reunião Eleven
```

## 5. Dados

- `auth/<nome>/` — sessão do WhatsApp daquela pessoa (não apague, a não ser que queira reconectar do zero).
- `data/<nome>.json` — tarefas/lembretes daquela pessoa (criado automaticamente).
- `instances/<nome>.env` — configuração daquela pessoa (chave Gemini, nome do grupo). **Não é versionado no git** (fica só nesta máquina).

## 6. Problemas comuns

- **Desconectou / parou de responder**: o log daquela instância mostra o motivo. Se disser "sessão desconectada", apague a pasta `auth/<nome>/` e rode `node src/index.js <nome>` de novo para gerar um novo QR code.
- **"Grupo não encontrado"** (só se `GROUP_NAME` estiver preenchido): precisa ser **idêntico** ao nome do grupo no WhatsApp, incluindo emojis (ex: `Jarvis🧠` ≠ `Jarvis`). O log mostra a lista de grupos encontrados se não bater. Deixando `GROUP_NAME` vazio esse problema não existe (usa a conversa "Mensagens para você mesmo").
