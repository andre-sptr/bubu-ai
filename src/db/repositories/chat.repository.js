const chatRepository = {
  addMessage({ chatId, scope, role, senderId = null, content, eventId = null, waMessageId = null }) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO messages(chat_id,scope,role,sender_id,content,event_id,wa_message_id,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(chatId, scope, role, senderId, content, eventId, waMessageId, new Date().toISOString());
    return result.changes === 1;
  },

  isBotOutboundMessage(chatId, waMessageId) {
    const id = String(waMessageId || '').trim();
    if (!chatId || !id) return false;
    return Boolean(
      this.db.prepare("SELECT 1 FROM messages WHERE chat_id=? AND role='assistant' AND wa_message_id=? LIMIT 1").get(chatId, id)
    );
  },

  clearMessages(chatId) {
    this.db.prepare('DELETE FROM messages WHERE chat_id=?').run(chatId);
  },

  getHistory(chatId, scope, limit = 16, excludeEventId = null) {
    return this.db.prepare(`SELECT role,content,sender_id FROM messages
      WHERE chat_id=? AND scope=? AND (? IS NULL OR event_id IS NULL OR event_id<>?)
      ORDER BY id DESC LIMIT ?`).all(chatId, scope, excludeEventId, excludeEventId, limit)
      .reverse().map((m) => ({ role: m.role, content: m.content, sender: m.sender_id }));
  },

  getChatOutputPreference({ chatId, requesterId, defaultMode = 'text' }) {
    const row = this.db.prepare(`
      SELECT voice_reply_mode, voice_reply_mode_is_set
      FROM chat_preferences
      WHERE chat_id=? AND requester_id=?
    `).get(chatId, requesterId);
    if (!row || !row.voice_reply_mode_is_set) {
      return { mode: defaultMode, isCustom: false };
    }
    return { mode: row.voice_reply_mode, isCustom: true };
  },

  getChatOutputMode({ chatId, requesterId, defaultMode = 'text' }) {
    return this.getChatOutputPreference({ chatId, requesterId, defaultMode }).mode;
  },

  setChatOutputMode({ chatId, requesterId, mode }) {
    if (!['text', 'voice', 'both'].includes(mode)) {
      throw new Error(`Unsupported chat output mode: ${mode}`);
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO chat_preferences(
        chat_id,requester_id,voice_reply_enabled,voice_reply_mode,
        voice_reply_mode_is_set,created_at,updated_at
      ) VALUES(?,?,?,?,1,?,?)
      ON CONFLICT(chat_id,requester_id)
      DO UPDATE SET voice_reply_enabled=excluded.voice_reply_enabled,
                    voice_reply_mode=excluded.voice_reply_mode,
                    voice_reply_mode_is_set=1,
                    updated_at=excluded.updated_at
    `).run(chatId, requesterId, mode === 'text' ? 0 : 1, mode, now, now);
    return this.getChatOutputMode({ chatId, requesterId });
  },

  resetChatOutputMode({ chatId, requesterId }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE chat_preferences
      SET voice_reply_mode_is_set=0, updated_at=?
      WHERE chat_id=? AND requester_id=?
    `).run(now, chatId, requesterId);
    return result.changes > 0;
  },

  // Backward-compatible boolean API for older integrations and tests.
  getChatPreference({ chatId, requesterId, defaultEnabled = false }) {
    const defaultMode = defaultEnabled ? 'both' : 'text';
    return this.getChatOutputMode({ chatId, requesterId, defaultMode }) !== 'text';
  },

  setVoiceReplyPreference({ chatId, requesterId, enabled }) {
    this.setChatOutputMode({
      chatId, requesterId, mode: enabled ? 'both' : 'text'
    });
    return this.getChatPreference({ chatId, requesterId });
  },

  addGroupPassiveMessage({ chatId, senderId = null, messageId = null, content, maxBuffer = 40 }) {
    const cleanChatId = String(chatId || '').trim();
    const cleanContent = String(content || '').trim().slice(0, 1500);
    if (!cleanChatId || !cleanContent) return false;
    const cleanMessageId = messageId ? String(messageId).trim() : null;
    const cap = Math.min(100, Math.max(5, Number(maxBuffer) || 40));
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      if (cleanMessageId) {
        const exists = this.db.prepare(
          'SELECT 1 FROM group_passive_messages WHERE chat_id=? AND message_id=? LIMIT 1'
        ).get(cleanChatId, cleanMessageId);
        if (exists) return false;
      }
      this.db.prepare(`
        INSERT INTO group_passive_messages(chat_id,sender_id,message_id,content,created_at)
        VALUES(?,?,?,?,?)
      `).run(cleanChatId, senderId || null, cleanMessageId, cleanContent, now);
      this.db.prepare(`
        DELETE FROM group_passive_messages
        WHERE chat_id=? AND id NOT IN (
          SELECT id FROM group_passive_messages
          WHERE chat_id=?
          ORDER BY id DESC
          LIMIT ?
        )
      `).run(cleanChatId, cleanChatId, cap);
      return true;
    })();
  },

  getGroupPassiveMessages(chatId, limit = 40) {
    const cleanChatId = String(chatId || '').trim();
    if (!cleanChatId) return [];
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 40));
    return this.db.prepare(`
      SELECT id, sender_id, message_id, content, created_at
      FROM group_passive_messages
      WHERE chat_id=?
      ORDER BY id DESC
      LIMIT ?
    `).all(cleanChatId, safeLimit).reverse().map((row) => ({
      id: row.id,
      sender: row.sender_id,
      messageId: row.message_id,
      content: row.content,
      createdAt: row.created_at
    }));
  },

  clearGroupPassiveMessages(chatId) {
    this.db.prepare('DELETE FROM group_passive_messages WHERE chat_id=?').run(chatId);
  },

  getAppSetting(key) {
    const row = this.db.prepare('SELECT value_json FROM app_settings WHERE key=?').get(String(key || ''));
    if (!row) return null;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return row.value_json;
    }
  },

  setAppSetting(key, value) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey) return false;
    const now = new Date().toISOString();
    const encoded = JSON.stringify(value ?? null);
    this.db.prepare(`
      INSERT INTO app_settings(key,value_json,updated_at)
      VALUES(?,?,?)
      ON CONFLICT(key)
      DO UPDATE SET value_json=excluded.value_json,
                    updated_at=excluded.updated_at
    `).run(cleanKey, encoded, now);
    return true;
  }
};

module.exports = { chatRepository };
