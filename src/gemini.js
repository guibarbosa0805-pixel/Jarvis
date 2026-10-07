import { GoogleGenAI, Type, createPartFromFunctionResponse } from '@google/genai';
import { addTask, listPending, completeTask, deleteTask } from './store.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const tools = [
  {
    functionDeclarations: [
      {
        name: 'create_reminder',
        description:
          'Cria uma tarefa/lembrete com data e hora para avisar o usuário no WhatsApp no momento certo. Use sempre que o usuário mencionar algo com prazo, horário ou compromisso (tarefa, reunião, ligação, etc).',
        parameters: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING, description: 'Descrição curta da tarefa, reunião ou compromisso.' },
            date: { type: Type.STRING, description: 'Data no formato YYYY-MM-DD.' },
            time: { type: Type.STRING, description: 'Horário no formato HH:mm em 24h.' },
            notes: { type: Type.STRING, description: 'Detalhes adicionais, opcional.' },
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

function runFunction(name, args) {
  switch (name) {
    case 'create_reminder': {
      const dueAt = new Date(`${args.date}T${args.time}:00`);
      if (Number.isNaN(dueAt.getTime())) {
        return { ok: false, error: 'Data/hora inválida. Use date=YYYY-MM-DD e time=HH:mm.' };
      }
      const task = addTask({ title: args.title, notes: args.notes, dueAt: dueAt.toISOString() });
      return { ok: true, task };
    }
    case 'list_pending_tasks':
      return { ok: true, tasks: listPending() };
    case 'complete_task': {
      const task = completeTask(args.id);
      return task ? { ok: true, task } : { ok: false, error: 'Tarefa não encontrada.' };
    }
    case 'delete_task':
      return { ok: deleteTask(args.id) };
    default:
      return { ok: false, error: `Função desconhecida: ${name}` };
  }
}

const SYSTEM_INSTRUCTION = `Você é o Jarvis, o assistente pessoal particular do usuário. Vocês conversam dentro de um grupo de WhatsApp onde ele é o único humano e fala só com você, para organizar a vida dele.

Seu papel:
- Ajudar a organizar tarefas, demandas e compromissos.
- Agendar lembretes usando a função create_reminder sempre que ele mencionar algo com prazo, hora ou data (ex: "me lembra de X às 15h", "tenho reunião com o cliente quinta às 10h"). Se faltar data ou hora, pergunte antes de chamar a função — não invente horário.
- Quando ele perguntar o que está pendente, use list_pending_tasks e responda de forma organizada e curta.
- Quando ele disser que terminou ou concluiu algo, use complete_task com o ID correspondente (chame list_pending_tasks antes se não souber o ID).
- Quando ele quiser cancelar algo, use delete_task.
- Quando ele pedir ideias, sugestões, brainstorm ou ajuda para pensar em algo, responda direto com ideias práticas e específicas — não precisa usar nenhuma função para isso.

Estilo:
- Responda em português do Brasil, direto e objetivo, sem formalidade excessiva.
- Mensagens curtas, isso é WhatsApp, não e-mail. Evite parágrafos longos e listas gigantes.
- Pode usar emojis com moderação quando fizer sentido (✅ ⏰ 💡).
- Toda mensagem do usuário vem precedida de "[Data/hora atual: ...]" entre colchetes — use isso só como referência pra calcular "hoje", "amanhã", "sexta que vem" etc, nunca repita esse trecho na resposta.`;

const chat = ai.chats.create({
  model: MODEL,
  config: { systemInstruction: SYSTEM_INSTRUCTION, tools },
});

export async function handleIncomingMessage(text) {
  const now = new Date().toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' });
  const augmented = `[Data/hora atual: ${now}]\n${text}`;

  let response = await chat.sendMessage({ message: augmented });

  let guard = 0;
  while (response.functionCalls?.length && guard < 5) {
    guard++;
    const responseParts = response.functionCalls.map((call) =>
      createPartFromFunctionResponse(call.id ?? call.name, call.name, runFunction(call.name, call.args || {})),
    );
    response = await chat.sendMessage({ message: responseParts });
  }

  return response.text?.trim() || 'Ok.';
}
