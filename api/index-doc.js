const { neon } = require('@neondatabase/serverless');

async function initDB(sql) {
  await sql`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS documents_content_trgm
    ON documents USING gin (content gin_trgm_ops);
  `;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Verificar contraseña de admin
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    await initDB(sql);

    // GET /api/index-doc -> listar documentos
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, name, LEFT(content, 100) as preview, created_at
        FROM documents ORDER BY created_at DESC
      `;
      return res.status(200).json({ documents: rows });
    }

    // POST /api/index-doc -> añadir documento
    if (req.method === 'POST') {
      const { name, content } = req.body;
      if (!name || !content) {
        return res.status(400).json({ error: 'Faltan campos: name y content son obligatorios' });
      }
      if (content.length > 100000) {
        return res.status(400).json({ error: 'El documento es demasiado largo (máx. 100.000 caracteres)' });
      }

      // Dividir en chunks de ~1000 caracteres para mejor búsqueda
      const chunkSize = 1000;
      const overlap = 100;
      const chunks = [];
      for (let i = 0; i < content.length; i += chunkSize - overlap) {
        chunks.push(content.substring(i, i + chunkSize));
        if (i + chunkSize >= content.length) break;
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunkName = chunks.length > 1 ? `${name} (parte ${i + 1}/${chunks.length})` : name;
        await sql`
          INSERT INTO documents (name, content) VALUES (${chunkName}, ${chunks[i]})
        `;
      }

      return res.status(200).json({
        success: true,
        message: `Documento "${name}" indexado en ${chunks.length} parte(s).`
      });
    }

    // DELETE /api/index-doc -> borrar documento por id
    if (req.method === 'DELETE') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'Falta el campo id' });
      await sql`DELETE FROM documents WHERE id = ${id}`;
      return res.status(200).json({ success: true, message: `Documento ${id} eliminado.` });
    }

    return res.status(405).json({ error: 'Método no permitido' });

  } catch (err) {
    console.error('Error en /api/index-doc:', err);
    return res.status(500).json({ error: 'Error interno del servidor', detail: err.message });
  }
};
