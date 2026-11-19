const { searchDocumentSnippets } = require('../../documents/parsers/page-search');

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
    this.db.prepare(`INSERT OR IGNORE INTO documents
      (id,scope,owner_id,chat_id,filename,mime_type,file_path,file_size,extracted_text,source_event_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      doc.id, doc.scope, doc.ownerId || null, doc.chatId || null, doc.filename,
      doc.mimeType, doc.filePath, doc.fileSize, doc.extractedText,
      doc.sourceEventId || null, now
    );
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
  }
};

module.exports = { documentRepository };
