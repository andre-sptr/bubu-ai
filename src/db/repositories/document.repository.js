const { searchDocumentSnippets } = require('../../documents/parsers/page-search');
const { chunkDocumentText } = require('../../documents/parsers/chunker');
const { cosineSimilarity, encodeEmbeddingBlob, decodeEmbeddingBlob } = require('../../utils/vector');

const documentRepository = {
  saveDocument(doc) {
    const now = new Date().toISOString();
    if (doc.sourceEventId) {
      const existing = this.db.prepare(`SELECT id,scope,filename,mime_type,file_size,extracted_text,created_at
        FROM documents WHERE source_event_id=? AND scope=? AND
        ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))`)
        .get(doc.sourceEventId, doc.scope, doc.ownerId || null, doc.chatId || null);
      if (existing) return existing;
    }
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO documents
      (id,scope,owner_id,chat_id,filename,mime_type,file_path,file_size,extracted_text,source_event_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      doc.id, doc.scope, doc.ownerId || null, doc.chatId || null, doc.filename,
      doc.mimeType, doc.filePath, doc.fileSize, doc.extractedText,
      doc.sourceEventId || null, now
    );
    if (inserted.changes > 0 && doc.extractedText) {
      try {
        const chunks = chunkDocumentText(doc.extractedText);
        if (chunks.length > 0) {
          this.replaceDocumentChunks({
            documentId: doc.id,
            scope: doc.scope,
            ownerId: doc.ownerId || null,
            chatId: doc.chatId || null,
            chunks
          });
        }
      } catch {
        // Non-fatal if document_chunks table is unavailable in a minimal test schema.
      }
    }
    return this.getDocument(doc.id, doc.scope, doc.ownerId || null, doc.chatId || null);
  },

  getDocument(id, scope, ownerId = null, chatId = null) {
    return this.db.prepare(`SELECT id,scope,filename,mime_type,file_size,extracted_text,created_at
      FROM documents WHERE id=? AND scope=? AND
      ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))`)
      .get(id, scope, ownerId, chatId) || null;
  },

  getDocumentFile(id, scope, ownerId = null, chatId = null) {
    return this.db.prepare(`SELECT id,scope,owner_id,chat_id,filename,mime_type,file_path,file_size,created_at
      FROM documents WHERE id=? AND scope=? AND
      ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))`)
      .get(id, scope, ownerId, chatId) || null;
  },

  listDocuments({ scope, ownerId = null, chatId = null, limit = 10 }) {
    return this.db.prepare(`SELECT id,filename,mime_type,file_size,created_at FROM documents
      WHERE scope=? AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
      ORDER BY created_at DESC LIMIT ?`).all(scope, ownerId, chatId, Math.max(1, Math.min(limit, 50)));
  },

  searchDocuments({ scope, ownerId = null, chatId = null, query, limit = 5 }) {
    const rawQuery = String(query || '').trim();
    const terms = rawQuery.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((x) => x.length >= 2);
    if (!terms.length) return [];
    const rows = this.db.prepare(`SELECT id,filename,mime_type,extracted_text,created_at FROM documents
      WHERE scope=? AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
      ORDER BY created_at DESC LIMIT 100`).all(scope, ownerId, chatId);
    return rows.map((row) => {
      const filenameLower = String(row.filename || '').toLowerCase();
      const filenameScore = terms.reduce((n, t) => n + (filenameLower.includes(t) ? 3 : 0), 0);
      const snippetResult = searchDocumentSnippets(row.extracted_text, rawQuery, {
        maxSnippets: 3,
        snippetChars: 550
      });
      const snippetScore = snippetResult.snippets.reduce((n, s) => n + s.score, 0);
      const totalScore = filenameScore + snippetScore;
      return {
        ...row,
        score: totalScore,
        snippets: snippetResult.snippets,
        matchedPages: snippetResult.snippets.map((s) => s.pageNumber),
        totalPages: snippetResult.totalPages,
        excerpt: snippetResult.excerpt || (filenameScore > 0 ? String(row.extracted_text || '').slice(0, 1800) : '')
      };
    }).filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at))
      .slice(0, Math.max(1, Math.min(limit, 20)))
      .map(({ extracted_text, ...row }) => row);
  },

  deleteDocument(id, scope, ownerId = null, chatId = null) {
    const existing = this.getDocumentFile(id, scope, ownerId, chatId);
    if (!existing) return null;
    const result = this.db.prepare(`DELETE FROM documents WHERE id=? AND scope=? AND
      ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))`)
      .run(id, scope, ownerId, chatId);
    return result.changes ? existing : null;
  },

  findDocumentBySourceEvent({ scope, ownerId = null, chatId = null, sourceEventIds = [] }) {
    const candidates = [...new Set(
      (Array.isArray(sourceEventIds) ? sourceEventIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    )];
    if (!candidates.length) return null;
    const placeholders = candidates.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT id, filename, mime_type FROM documents
       WHERE scope = ? AND ((scope = 'personal' AND owner_id = ?) OR (scope = 'group' AND chat_id = ?))
       AND source_event_id IN (${placeholders})
       LIMIT 1`
    ).get(scope, scope === 'personal' ? ownerId : null, scope === 'group' ? chatId : null, ...candidates) || null;
  },

  listDocumentFilePaths() {
    return this.db.prepare('SELECT file_path FROM documents WHERE file_path IS NOT NULL')
      .all()
      .map((r) => r.file_path)
      .filter(Boolean);
  },

  replaceDocumentChunks({ documentId, scope, ownerId = null, chatId = null, chunks = [] }) {
    const normalizedOwner = scope === 'personal' ? ownerId : null;
    const normalizedChat = scope === 'group' ? chatId : null;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM document_chunks WHERE document_id=?').run(documentId);
      const insertStmt = this.db.prepare(`
        INSERT INTO document_chunks (
          document_id, scope, owner_id, chat_id, chunk_index, page_number, content, embedding_blob, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const content = String(chunk?.content || '').trim();
        if (!content) continue;
        const idx = Number.isInteger(Number(chunk?.chunkIndex)) ? Number(chunk.chunkIndex) : i;
        const pageNo = Math.max(1, Number(chunk?.pageNumber) || 1);
        const blob = encodeEmbeddingBlob(chunk?.embedding || null);
        insertStmt.run(documentId, scope, normalizedOwner, normalizedChat, idx, pageNo, content, blob, now);
      }
      return chunks.length;
    });
    return tx();
  },

  listDocumentChunks({ documentId, scope, ownerId = null, chatId = null }) {
    const normalizedOwner = scope === 'personal' ? ownerId : null;
    const normalizedChat = scope === 'group' ? chatId : null;
    return this.db.prepare(`
      SELECT id, document_id, chunk_index, page_number, content,
             CASE WHEN embedding_blob IS NOT NULL THEN 1 ELSE 0 END AS embedded,
             created_at
      FROM document_chunks
      WHERE document_id=? AND scope=?
        AND ((scope='personal' AND owner_id=?) OR (scope='group' AND chat_id=?))
      ORDER BY chunk_index ASC
    `).all(documentId, scope, normalizedOwner, normalizedChat);
  },

  searchDocumentChunks({
    scope, ownerId = null, chatId = null, query = '',
    queryEmbedding = null, documentId = null, limit = 8
  }) {
    const tableRow = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_chunks'").get();
    if (!tableRow) return [];

    const normalizedOwner = scope === 'personal' ? ownerId : null;
    const normalizedChat = scope === 'group' ? chatId : null;
    const rows = this.db.prepare(`
      SELECT c.document_id, c.chunk_index, c.page_number, c.content, c.embedding_blob,
             d.filename, d.mime_type, d.created_at
      FROM document_chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.scope=?
        AND ((c.scope='personal' AND c.owner_id=?) OR (c.scope='group' AND c.chat_id=?))
        AND (? IS NULL OR c.document_id=?)
      ORDER BY d.created_at DESC, c.chunk_index ASC
      LIMIT 600
    `).all(scope, normalizedOwner, normalizedChat, documentId, documentId);

    const terms = String(query || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((term) => term.length >= 2);

    const scored = rows.map((row) => {
      const haystack = `${row.filename || ''} ${row.content || ''}`.toLowerCase();
      const lexical = terms.length
        ? terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0) / terms.length
        : 0;
      const vector = queryEmbedding && row.embedding_blob
        ? decodeEmbeddingBlob(row.embedding_blob)
        : null;
      const semantic = queryEmbedding && vector
        ? cosineSimilarity(queryEmbedding, vector)
        : 0;
      const score = queryEmbedding
        ? semantic * 0.72 + lexical * 0.28
        : lexical;
      return {
        documentId: row.document_id,
        filename: row.filename,
        mimeType: row.mime_type,
        createdAt: row.created_at,
        chunkIndex: row.chunk_index,
        pageNumber: row.page_number,
        content: row.content,
        score,
        semanticScore: semantic,
        lexicalScore: lexical
      };
    });

    return scored
      .filter((row) => queryEmbedding
        ? row.semanticScore >= 0.25 || row.lexicalScore > 0
        : terms.length === 0 || row.lexicalScore > 0)
      .sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt) || a.chunkIndex - b.chunkIndex)
      .slice(0, Math.max(1, Math.min(Number(limit) || 8, 30)));
  }
};

module.exports = { documentRepository };
