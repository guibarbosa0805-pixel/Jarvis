import { GoogleGenAI, Type, createPartFromFunctionResponse, createUserContent, createPartFromBase64 } from '@google/genai';
import * as defaultStore from './store.js';
import { formatDateShort, formatTime } from './format.js';

const tools = [
  {
    functionDeclarations: [
      {
        name: 'create_reminder',
        description:
          'Cria uma tarefa/lembrete com data e hora para avisar no momento certo (e um pouco antes). Use sempre que mencionarem algo com prazo, horário ou compromisso (tarefa, reunião, ligação, evento, etc).',
        parameters: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING, description: 'Descrição curta da tarefa, reunião ou compromisso.' },
            date: { type: Type.STRING, description: 'Data no formato YYYY-MM-DD.' },
            time: { type: Type.STRING, description: 'Horário no formato HH:mm em 24h.' },
            notes: { type: Type.STRING, description: 'Detalhes adicionais, opcional.' },
            link: {
              type: Type.STRING,
              description: 'URL mencionada na mensagem original (link de reunião, evento, etc), se houver. Copie exatamente como veio.',
            },
            lead_minutes: {
              type: Type.NUMBER,
              description: 'Quantos minutos antes do horário avisar com antecedência. Padrão 30 se o usuário não especificar outro valor.',
            },
          },
          required: ['title', 'date', 'time'],
        },
      },
      {
        name: 'list_pending_tasks',
        description: 'Lista as tarefas e lembretes pendentes, com seus IDs e horários.',
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: 'complete_task',
        description:
          'Marca uma tarefa como concluída pelo ID. Se não souber o ID, chame list_pending_tasks antes para encontrar pelo título.',
        parameters: {
          type: Type.OBJECT,
          properties: { id: { type: Type.STRING, description: 'ID da tarefa retornado por list_pending_tasks.' } },
          required: ['id'],
        },
      },
      {
        name: 'delete_task',
        description: 'Cancela/remove uma tarefa ou lembrete pelo ID, sem marcar como concluída.',
        parameters: {
          type: Type.OBJECT,
          properties: { id: { type: Type.STRING, description: 'ID da tarefa retornado por list_pending_tasks.' } },
          required: ['id'],
        },
      },
    ],
  },
];

function buildSystemInstruction(displayName, channelLabel) {
  return `Você é o Jarvis, secretário(a) pessoal particular de ${displayName}. Vocês conversam ${channelLabel}, só vocês dois, pra organizar a vida dele(a).

Seu papel:
- Ajudar a organizar tarefas, demandas e compromissos.
- Agendar lembretes usando create_reminder sempre que ${displayName} mencionar algo com prazo, horário ou compromisso (ex: "me lembra de X às 15h", "reunião com o cliente quinta às 10h", "masterclass hoje às 19:30 <link>"). Se faltar data ou hora, pergunte antes de chamar a função — não invente horário.
- Se a mensagem tiver uma URL (link de reunião, evento, inscrição), sempre passe no campo "link" da função.
- Não precisa perguntar quanto tempo de antecedência avisar — use o padrão (30 min) a não ser que a pessoa peça outro.
- Quando perguntarem o que está pendente, use list_pending_tasks e responda de forma organizada e curta.
- Quando disserem que terminaram/concluíram algo, use complete_task (chame list_pending_tasks antes se não souber o ID).
- Quando quiserem cancelar algo, use delete_task.
- Quando pedirem ideias, sugestões, brainstorm ou ajuda pra pensar em algo, responda direto com ideias práticas e específicas — não precisa usar nenhuma função pra isso.

Formato da confirmação (depois de um create_reminder com ok: true — use os valores de "formatted" exatamente como vieram, não calcule datas por conta própria):

✅ Agendado, ${displayName}!

📅 <título>
📆 <formatted.date_short> às <formatted.time>
⏰ Lembrete: <formatted.lead_time>
🔗 Link: <link, só inclua esta linha se houver link>

<uma frase curta e simpática de fechamento, variando a cada vez — ex: oferecer mostrar o resto da agenda do dia ou do dia seguinte, ou só um "beleza!" descontraído>

Estilo geral:
- Português do Brasil, caloroso mas direto — é um(a) secretário(a) de confiança, não um robô formal.
- Pode chamar ${displayName} pelo nome de vez em quando, principalmente em saudações e confirmações.
- Mensagens curtas. Emojis com moderação fora do template de confirmação (✅ ⏰ 💡 📅 🔗).
- Toda mensagem recebida vem precedida de "[Data/hora atual: ...]" entre colchetes — use só como referência pra calcular "hoje", "amanhã", "sexta que vem" etc, nunca repita esse trecho na resposta.`;
}

function runFunction(store, name, args) {
  switch (name) {
    case 'create_reminder': {
      const dueAt = new Date(`${args.date}T${args.time}:00`);
      if (Number.isNaN(dueAt.getTime())) {
        return { ok: false, error: 'Data/hora inválida. Use date=YYYY-MM-DD e time=HH:mm.' };
      }
      const leadMinutes = Number.isFinite(args.lead_minutes) ? args.lead_minutes : undefined;
      const task = store.addTask({
        title: args.title,
        notes: args.notes,
        dueAt: dueAt.toISOString(),
        link: args.link,
        leadMinutes,
      });
      const leadAt = new Date(dueAt.getTime() - task.leadMinutes * 60000);
      return {
        ok: true,
        task,
        formatted: {
          date_short: formatDateShort(task.dueAt),
          time: formatTime(task.dueAt),
          lead_time: formatTime(leadAt.toISOString()),
        },
      };
    }
    case 'list_pending_tasks':
      return { ok: true, tasks: store.listPending() };
    case 'complete_task': {
      const task = store.completeTask(args.id);
      return task ? { ok: true, task } : { ok: false, error: 'Tarefa não encontrada.' };
    }
    case 'delete_task':
      return { ok: store.deleteTask(args.id) };
    default:
      return { ok: false, error: `Função desconhecida: ${name}` };
  }
}

/**
 * Cria uma sessão de conversa independente com o Jarvis: próprio histórico,
 * própria chave/modelo Gemini e próprio store de tarefas.
 */
export function createBrain({ apiKey, model, displayName, store, channelLabel = 'no WhatsApp' }) {
  const ai = new GoogleGenAI({ apiKey });
  const chat = ai.chats.create({
    model: model || 'gemini-3.5-flash-lite',
    config: { systemInstruction: buildSystemInstruction(displayName, channelLabel), tools },
  });

  return {
    async handleIncomingMessage(text) {
      const now = new Date().toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' });
      const augmented = `[Data/hora atual: ${now}]\n${text}`;

      let response = await chat.sendMessage({ message: augmented });

      let guard = 0;
      while (response.functionCalls?.length && guard < 5) {
        guard++;
        const responseParts = response.functionCalls.map((call) =>
          createPartFromFunctionResponse(call.id ?? call.name, call.name, runFunction(store, call.name, call.args || {})),
        );
        response = await chat.sendMessage({ message: responseParts });
      }

      return response.text?.trim() || 'Ok.';
    },

    async transcribeAudio(buffer, mimeType) {
      const response = await ai.models.generateContent({
        model: model || 'gemini-3.5-flash-lite',
        contents: createUserContent([
          'Transcreva o áudio a seguir em português do Brasil. Responda só com o texto transcrito, sem comentários, sem aspas ao redor.',
          createPartFromBase64(buffer.toString('base64'), mimeType),
        ]),
      });
      return response.text?.trim() || '';
    },
  };
}

// Sessão padrão do processo atual, usada pelo bot do WhatsApp (lê config do process.env).
// Criada sob demanda pra não instanciar o cliente Gemini quando este módulo é
// importado só pela fábrica createBrain (caso do chat web do painel).
let _defaultBrain = null;
function getDefaultBrain() {
  if (!_defaultBrain) {
    _defaultBrain = createBrain({
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL,
      displayName: process.env.DISPLAY_NAME || (process.env.INSTANCE_NAME || 'você').replace(/^./, (c) => c.toUpperCase()),
      store: defaultStore,
      channelLabel: 'no WhatsApp',
    });
  }
  return _defaultBrain;
}

export function transcribeAudio(buffer, mimeType) {
  return getDefaultBrain().transcribeAudio(buffer, mimeType);
}

export function handleIncomingMessage(text) {
  return getDefaultBrain().handleIncomingMessage(text);
}
