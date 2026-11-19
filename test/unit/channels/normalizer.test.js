const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIncoming, normalizeSessionStatus } = require('../../../src/channels/waha/normalizer');
const { normalizeJid } = require('../../../src/config/env');

test('normalizes DM WAHA payload', () => {
  const m = normalizeIncoming({ event: 'message', payload: { id: 'id1', from: '6281@c.us', author: '6281@c.us', body: 'halo' } });
  assert.equal(m.chatId, '6281@c.us');
  assert.equal(m.senderId, '6281@c.us');
  assert.equal(m.text, 'halo');
  assert.equal(m.eventId, 'id1');
});
test('normalizes group payload', () => {
  const m = normalizeIncoming({ payload: { id: 'id2', from: '123@g.us', author: '6281@c.us', body: 'Bubu halo' } });
  assert.equal(m.chatId, '123@g.us');
  assert.equal(m.senderId, '6281@c.us');
});
test('normalizes phone JID variants', () => {
  assert.equal(normalizeJid('628123@s.whatsapp.net'), '628123@c.us');
});


test('normalizes WAHA media attachment metadata', () => {
  const m = normalizeIncoming({
    payload: {
      id: 'media1', from: '6281@c.us', author: '6281@c.us',
      body: 'Please read this', hasMedia: true,
      media: { url: 'http://127.0.0.1:3001/api/files/a.pdf', filename: 'a.pdf', mimetype: 'application/pdf' }
    }
  });
  assert.equal(m.hasMedia, true);
  assert.equal(m.media.filename, 'a.pdf');
});


test('normalizes native WAHA mention metadata from common payload shapes', () => {
  const a = normalizeIncoming({
    payload: {
      from: '123@g.us',
      author: '6281@c.us',
      body: 'Tolong bantu',
      mentionedIds: ['628999@c.us']
    }
  });
  assert.deepEqual(a.mentions, ['628999@c.us']);

  const b = normalizeIncoming({
    payload: {
      from: '123@g.us',
      author: '6281@c.us',
      body: 'Tolong bantu',
      _data: { Info: { MentionedJID: '628999@s.whatsapp.net' } }
    }
  });
  assert.deepEqual(b.mentions, ['628999@s.whatsapp.net']);
});


test('uses media caption when WAHA body is an empty string', () => {
  const m = normalizeIncoming({
    payload: {
      from: '123@g.us',
      author: '6281@c.us',
      body: '',
      caption: 'Bubu tolong analisis gambar ini',
      hasMedia: true,
      media: { url: 'http://waha:3000/api/files/image.jpg', mimetype: 'image/jpeg' }
    }
  });
  assert.equal(m.text, 'Bubu tolong analisis gambar ini');
  assert.equal(m.hasMedia, true);
});


test('normalizes native GOWS image media fields and caption from Message.imageMessage', () => {
  const m = normalizeIncoming({
    event: 'message',
    payload: {
      id: 'gows-image-1',
      from: '6281@c.us',
      author: '6281@c.us',
      hasMedia: true,
      _data: {
        Info: { Chat: '6281@c.us', Sender: '6281@c.us', MediaType: 'image', IsFromMe: false },
        Message: {
          imageMessage: {
            URL: 'https://waha.example/api/files/image',
            caption: 'Inspect this picture',
            mimetype: 'image/jpeg',
            fileLength: 153976,
            width: 1200,
            height: 1600
          }
        },
        RawMessage: {
          imageMessage: {
            URL: 'https://waha.example/api/files/image',
            caption: 'Inspect this picture',
            mimetype: 'image/jpeg'
          }
        }
      }
    }
  });

  assert.equal(m.hasMedia, true);
  assert.equal(m.text, 'Inspect this picture');
  assert.equal(m.media.url, 'https://waha.example/api/files/image');
  assert.equal(m.media.mimetype, 'image/jpeg');
  assert.equal(m.media.mediaType, 'image');
  assert.equal(m.media.fileLength, 153976);
});

test('normalizes native GOWS PTT metadata without exposing encryption fields', () => {
  const m = normalizeIncoming({
    payload: {
      id: 'gows-ptt-1',
      from: '6281@c.us',
      author: '6281@c.us',
      _data: {
        Info: { Chat: '6281@c.us', Sender: '6281@c.us', MediaType: 'ptt' },
        Message: {
          audioMessage: {
            URL: 'https://waha.example/api/files/voice',
            mimetype: 'audio/ogg; codecs=opus',
            PTT: true,
            seconds: 8,
            fileLength: 20519,
            mediaKey: 'must-not-be-copied'
          }
        }
      }
    }
  });

  assert.equal(m.hasMedia, true);
  assert.equal(m.media.mediaType, 'ptt');
  assert.equal(m.media.isPtt, true);
  assert.equal(m.media.durationSeconds, 8);
  assert.equal(m.media.fileLength, 20519);
  assert.equal(m.media.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(Object.hasOwn(m.media, 'mediaKey'), false);
});

test('normalizes native GOWS video and document captions', () => {
  const video = normalizeIncoming({
    payload: {
      from: '6281@c.us',
      body: '',
      _data: {
        Info: { MediaType: 'video' },
        Message: { videoMessage: {
          URL: 'https://waha.example/video',
          caption: 'video caption',
          mimetype: 'video/mp4',
          seconds: 5
        } }
      }
    }
  });
  assert.equal(video.hasMedia, true);
  assert.equal(video.text, 'video caption');
  assert.equal(video.media.mediaType, 'video');

  const document = normalizeIncoming({
    payload: {
      from: '6281@c.us',
      _data: {
        Info: { MediaType: 'document' },
        Message: { documentMessage: {
          URL: 'https://waha.example/report',
          fileName: 'report.pdf',
          mimetype: 'application/pdf',
          caption: 'Please read'
        } }
      }
    }
  });
  assert.equal(document.hasMedia, true);
  assert.equal(document.text, 'Please read');
  assert.equal(document.media.filename, 'report.pdf');
  assert.equal(document.media.mimetype, 'application/pdf');
});

test('keeps media-only event true when GOWS URL is empty', () => {
  const m = normalizeIncoming({
    payload: {
      from: '6281@c.us',
      _data: {
        Info: { MediaType: 'image' },
        Message: { imageMessage: { URL: '', mimetype: 'image/jpeg' } }
      }
    }
  });
  assert.equal(m.hasMedia, true);
  assert.equal(m.media.url, '');
});


test('separates GOWS current message body and image caption', () => {
  const m = normalizeIncoming({
    event: 'message',
    payload: {
      id: 'body-caption-1',
      from: '6281@c.us',
      body: 'Please inspect this',
      hasMedia: true,
      _data: {
        Info: { Chat: '6281@c.us', MediaType: 'image' },
        Message: {
          imageMessage: {
            URL: 'https://waha.example/image',
            caption: 'Front label photo',
            mimetype: 'image/jpeg'
          }
        }
      }
    }
  });
  assert.equal(m.bodyText, 'Please inspect this');
  assert.equal(m.captionText, 'Front label photo');
  assert.equal(m.text, 'Please inspect this\n\nFront label photo');
  assert.equal(m.media.url, 'https://waha.example/image');
});

test('extracts sanitized quoted image metadata from observed GOWS contextInfo', () => {
  const m = normalizeIncoming({
    payload: {
      id: 'quote-image-1',
      from: '6281@c.us',
      body: 'What does this picture show?',
      _data: {
        Info: { Chat: '6281@c.us', IsFromMe: false },
        Message: {
          extendedTextMessage: {
            text: 'What does this picture show?',
            contextInfo: {
              stanzaID: 'private-stanza',
              participant: 'private-participant',
              quotedMessage: {
                imageMessage: {
                  URL: 'https://private.example/media',
                  caption: 'Quoted photo caption',
                  mimetype: 'image/jpeg',
                  mediaKey: 'private-media-key'
                }
              }
            }
          }
        }
      }
    }
  });
  assert.equal(m.quote.present, true);
  assert.equal(m.quote.type, 'image');
  assert.equal(m.quote.text, 'Quoted photo caption');
  assert.equal(m.quote.mimeType, 'image/jpeg');
  assert.equal(m.quote.hasMedia, true);
  assert.equal(JSON.stringify(m.quote).includes('private.example'), false);
  assert.equal(JSON.stringify(m.quote).includes('private-media-key'), false);
  assert.equal(Object.hasOwn(m.quote, 'participant'), false);
  assert.equal(Object.hasOwn(m.quote, 'stanzaID'), false);
});

test('rejects quote when explicit remoteJid differs from current chat', () => {
  const m = normalizeIncoming({
    payload: {
      id: 'cross-chat-quote',
      from: '6281@c.us',
      body: 'Explain this reply',
      _data: {
        Info: { Chat: '6281@c.us' },
        Message: {
          extendedTextMessage: {
            contextInfo: {
              remoteJid: '120363000000000000@g.us',
              stanzaID: 'private-id',
              quotedMessage: { conversation: 'private quoted text' }
            }
          }
        }
      }
    }
  });
  assert.deepEqual(m.quote, {
    present: false,
    rejected: true,
    reason: 'cross_chat_reference'
  });
});

test('quote-only webhook is recognized without promoting quote text to current text', () => {
  const m = normalizeIncoming({
    payload: {
      id: 'quote-only',
      from: '6281@c.us',
      body: '',
      _data: {
        Info: { Chat: '6281@c.us' },
        Message: {
          extendedTextMessage: {
            contextInfo: { quotedMessage: { conversation: 'Quoted content' } }
          }
        }
      }
    }
  });
  assert.equal(m.text, '');
  assert.equal(m.quote.present, true);
});

test('unwraps object IDs for chatId, senderId, and eventId without [object Object]', () => {
  const m = normalizeIncoming({
    event: 'message',
    payload: {
      id: { fromMe: false, remote: '6281@c.us', id: 'ABC99', _serialized: 'false_6281@c.us_ABC99' },
      from: { _serialized: '120363@g.us', user: '120363', server: 'g.us' },
      author: { user: '6282', server: 'c.us' },
      body: 'Obj ID test'
    }
  });
  assert.equal(m.eventId, 'false_6281@c.us_ABC99');
  assert.equal(m.chatId, '120363@g.us');
  assert.equal(m.senderId, '6282@c.us');
  assert.equal(JSON.stringify(m).includes('[object Object]'), false);
});

test('unwraps ephemeralMessage, viewOnceMessage, and viewOnceMessageV2 on incoming messages', () => {
  const m = normalizeIncoming({
    event: 'message',
    payload: {
      id: 'ephem-1',
      from: '123@g.us',
      author: '6281@c.us',
      _data: {
        Info: { Chat: '123@g.us', Sender: '6281@c.us', MediaType: 'image' },
        Message: {
          ephemeralMessage: {
            message: {
              viewOnceMessageV2: {
                message: {
                  imageMessage: {
                    URL: 'https://waha.example/viewonce.jpg',
                    caption: 'Secret photo',
                    mimetype: 'image/jpeg',
                    contextInfo: {
                      mentionedJid: ['628999@c.us'],
                      stanzaID: 'stanza-ephem',
                      participant: '6281@c.us',
                      quotedMessage: { conversation: 'Previous message' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });
  assert.equal(m.hasMedia, true);
  assert.equal(m.media.url, 'https://waha.example/viewonce.jpg');
  assert.equal(m.captionText, 'Secret photo');
  assert.equal(m.text, 'Secret photo');
  assert.deepEqual(m.mentions, ['628999@c.us']);
  assert.equal(m.quote.present, true);
  assert.equal(m.quote.text, 'Previous message');
  assert.equal(m.quote.quotedMessageId, 'stanza-ephem');
  assert.equal(m.quote.quotedParticipant, '6281@c.us');
});

test('detects isPtt across lowercase ptt, source.ptt, and Info.MediaType=ptt', () => {
  const fromLowerNative = normalizeIncoming({
    payload: {
      id: 'ptt-lower',
      from: '6281@c.us',
      _data: {
        Message: { audioMessage: { URL: 'https://waha.example/a.ogg', mimetype: 'audio/ogg', ptt: true } }
      }
    }
  });
  assert.equal(fromLowerNative.media.isPtt, true);

  const fromSourcePtt = normalizeIncoming({
    payload: {
      id: 'ptt-source',
      from: '6281@c.us',
      hasMedia: true,
      media: { url: 'https://waha.example/a.ogg', mimetype: 'audio/ogg', ptt: true }
    }
  });
  assert.equal(fromSourcePtt.media.isPtt, true);

  const fromInfoMediaType = normalizeIncoming({
    payload: {
      id: 'ptt-info',
      from: '6281@c.us',
      _data: {
        Info: { MediaType: 'PTT' },
        Message: { audioMessage: { URL: 'https://waha.example/a.ogg', mimetype: 'audio/ogg' } }
      }
    }
  });
  assert.equal(fromInfoMediaType.media.isPtt, true);
});

test('extracts payload.replyTo.body quotes and retains internal quotedMessageId and quotedParticipant', () => {
  const m = normalizeIncoming({
    payload: {
      id: 'reply-body-1',
      from: '6281@c.us',
      body: 'Setuju!',
      replyTo: {
        id: 'orig-msg-42',
        chatId: '6281@c.us',
        participant: '6289@c.us',
        body: 'Kita ketemu jam 3 sore'
      }
    }
  });
  assert.equal(m.quote.present, true);
  assert.equal(m.quote.type, 'text');
  assert.equal(m.quote.text, 'Kita ketemu jam 3 sore');
  assert.equal(m.quote.referenceIdPresent, true);
  assert.equal(m.quote.quotedMessageId, 'orig-msg-42');
  assert.equal(m.quote.quotedParticipant, '6289@c.us');
  assert.equal(Object.hasOwn(m.quote, 'participant'), false);
  assert.equal(Object.hasOwn(m.quote, 'stanzaID'), false);
});

test('normalizeSessionStatus normalizes session, status, and bot JID metadata', () => {
  const s = normalizeSessionStatus({
    event: 'session.status',
    session: 'bubu-prod',
    timestamp: 1712345678,
    me: { id: '628999:1@s.whatsapp.net' },
    payload: { name: 'bubu-prod', status: 'scan_qr_code' }
  });
  assert.deepEqual(s, {
    eventType: 'session.status',
    session: 'bubu-prod',
    status: 'SCAN_QR_CODE',
    meId: '628999@c.us',
    timestamp: 1712345678
  });
});
