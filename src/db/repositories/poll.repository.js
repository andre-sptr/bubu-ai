const pollRepository = {
  savePoll({ pollMessageId, chatId, scope = 'group', question, options = [], multipleAnswers = false }) {
    const cleanPollId = String(pollMessageId || '').trim();
    const cleanChatId = String(chatId || '').trim();
    const cleanQuestion = String(question || '').trim();
    if (!cleanPollId || !cleanChatId || !cleanQuestion) return false;
    const cleanScope = scope === 'personal' ? 'personal' : 'group';
    const cleanOptions = Array.isArray(options)
      ? options.map((opt) => String(opt || '').trim()).filter(Boolean)
      : [];
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR REPLACE INTO polls(
        poll_message_id,chat_id,scope,question,options_json,multiple_answers,created_at
      ) VALUES(?,?,?,?,?,?,?)
    `).run(cleanPollId, cleanChatId, cleanScope, cleanQuestion, JSON.stringify(cleanOptions), multipleAnswers ? 1 : 0, now);
    return true;
  },

  recordPollVote({ pollMessageId, voterId, selectedOptions = [] }) {
    const cleanPollId = String(pollMessageId || '').trim();
    const cleanVoterId = String(voterId || '').trim();
    if (!cleanPollId || !cleanVoterId) return false;
    const cleanOptions = Array.isArray(selectedOptions)
      ? [...new Set(selectedOptions.map((opt) => String(opt || '').trim()).filter(Boolean))]
      : [];
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO poll_votes(poll_message_id,voter_id,selected_options_json,updated_at)
      VALUES(?,?,?,?)
      ON CONFLICT(poll_message_id,voter_id)
      DO UPDATE SET selected_options_json=excluded.selected_options_json,
                    updated_at=excluded.updated_at
    `).run(cleanPollId, cleanVoterId, JSON.stringify(cleanOptions), now);
    return true;
  },

  getPollResults({ pollMessageId = null, chatId = null, scope = 'group' } = {}) {
    const requestedId = String(pollMessageId || '').trim();
    let poll = null;
    if (requestedId) {
      poll = this.db.prepare('SELECT * FROM polls WHERE poll_message_id=?').get(requestedId) || null;
      if (poll && scope === 'group' && chatId && poll.chat_id !== chatId) {
        return { found: false, reason: 'cross_chat_forbidden' };
      }
    } else if (scope === 'group') {
      if (!chatId) return { found: false };
      poll = this.db.prepare('SELECT * FROM polls WHERE chat_id=? ORDER BY created_at DESC LIMIT 1').get(chatId) || null;
    } else {
      poll = (chatId
        ? this.db.prepare('SELECT * FROM polls WHERE chat_id=? ORDER BY created_at DESC LIMIT 1').get(chatId)
        : null) ||
        this.db.prepare('SELECT * FROM polls ORDER BY created_at DESC LIMIT 1').get() ||
        null;
    }

    const targetId = poll?.poll_message_id || requestedId;
    if (!targetId) return { found: false };

    const votes = this.db.prepare(
      'SELECT voter_id, selected_options_json, updated_at FROM poll_votes WHERE poll_message_id=? ORDER BY updated_at DESC'
    ).all(targetId);
    if (!poll && votes.length === 0) return { found: false };

    const tallyMap = new Map();
    let seededOptions = [];
    if (poll?.options_json) {
      try {
        seededOptions = JSON.parse(poll.options_json);
      } catch {
        seededOptions = [];
      }
    }
    for (const opt of Array.isArray(seededOptions) ? seededOptions : []) {
      const label = String(opt || '').trim();
      if (label && !tallyMap.has(label)) tallyMap.set(label, []);
    }

    let totalVoters = 0;
    for (const row of votes) {
      let selected = [];
      try {
        selected = JSON.parse(row.selected_options_json);
      } catch {
        selected = [];
      }
      if (!Array.isArray(selected) || selected.length === 0) continue;
      totalVoters += 1;
      for (const opt of selected) {
        const label = String(opt || '').trim();
        if (!label) continue;
        if (!tallyMap.has(label)) tallyMap.set(label, []);
        tallyMap.get(label).push(row.voter_id);
      }
    }

    return {
      found: true,
      pollMessageId: targetId,
      chatId: poll?.chat_id || chatId || null,
      question: poll?.question || '(Polling tanpa metadata)',
      options: [...tallyMap.keys()],
      multipleAnswers: Boolean(poll?.multiple_answers),
      totalVoters,
      tally: [...tallyMap.entries()].map(([option, voters]) => ({
        option,
        votes: voters.length,
        voters
      })),
      createdAt: poll?.created_at || null
    };
  },

  listPolls({ chatId = null, scope = 'group', limit = 10 } = {}) {
    const safeLimit = Math.min(20, Math.max(1, Number(limit) || 10));
    if (scope === 'group' && !chatId) return [];
    const rows = scope === 'group'
      ? this.db.prepare('SELECT poll_message_id FROM polls WHERE chat_id=? ORDER BY created_at DESC LIMIT ?').all(chatId, safeLimit)
      : this.db.prepare('SELECT poll_message_id FROM polls ORDER BY created_at DESC LIMIT ?').all(safeLimit);
    return rows
      .map((row) => this.getPollResults({ pollMessageId: row.poll_message_id, chatId, scope }))
      .filter((entry) => entry?.found);
  }
};

module.exports = { pollRepository };
