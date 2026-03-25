const Groq = require('groq-sdk');
const { neon } = require('@neondatabase/serverless');
const { Redis } = require('@upstash/redis');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const SYSTEM_PROMPT = `Eres un asistente inteligente y útil. Respondes siempre en español.
Cuando tengas información relevante en el contexto de documentos, úsala para responder con precisión.
Si no tienes información suficiente sobre algo, dilo claramente en lugar de inventar.
Sé conciso, amable y profesional.`;

async function searchDocuments(query) {
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`
      SELECT name, content,
        similarity(content, ${query}) as score
      FROM documents
      WHERE similarity(content, ${query}) > 0.1
      ORDER BY score DESC
      LIMIT 3
    `;
    return rows;
  } catch (err) {
    console.error('Error buscando documentos:', err);
    return [];
  }
}

async function getSessionHistory(sessionId) {
  try {
    const history = await redis.get(`session:${sessionId}`);
    return history ? JSON.parse(history) : [];
  } catch {
    return [];
  }
}

async function saveSessionHistory(sessionId, messages) {
  try {
    // Guardar solo los últimos 20 mensajes para no saturar
    const trimmed = messages.slice(-20);
    await redis.set(`session:${sessionId}`, JSON.stringify(trimmed), { ex: 3600 });
  } catch (err) {
    console.error('Error guardando historial:', err);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { message, sessionId } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'Faltan campos: message y sessionId son obligatorios' });
  }

  try {
    // 1. Buscar documentos relevantes (RAG)
    const docs = await searchDocuments(message);
    let contextText = '';
    if (docs.length > 0) {
      contextText = '\n\nInformación relevante de los documentos:\n' +
        docs.map(d => `[${d.name}]: ${d.content.substring(0, 500)}`).join('\n\n');
    }

    // 2. Obtener historial de la sesión
    const history = await getSessionHistory(sessionId);

    // 3. Construir mensajes para la API
    const messages = [
      ...history,
      { role: 'user', content: message + contextText }
    ];

    // 4. Llamar a Groq LLaMA 4
    const completion = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages
      ],
      max_tokens: 1024,
      temperature: 0.7,
    });

    const reply = completion.choices[0]?.message?.content || 'No pude generar una respuesta.';

    // 5. Guardar historial actualizado
    const updatedHistory = [
      ...history,
      { role: 'user', content: message },
      { role: 'assistant', content: reply }
    ];
    await saveSessionHistory(sessionId, updatedHistory);

    return res.status(200).json({ reply, docsUsed: docs.length });

  } catch (err) {
    console.error('Error en /api/chat:', err);
    return res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};
