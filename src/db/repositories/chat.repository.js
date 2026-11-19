const chatRepository = {
  addMessage({ chatId, scope, role, senderId = null, content, eventId = null }) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO messages(chat_id,scope,role,sender_id,content,event_id,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(chatId, scope, role, senderId, content, eventId, new Date().toISOString());
    return result.changes === 1;
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
  }
};

module.exports = { chatRepository };
