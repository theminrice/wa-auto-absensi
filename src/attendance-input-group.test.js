'use strict';

const assert = require('assert');

const {
  INPUT_GROUP_NAME,
  findPaleluGroup,
  isPaleluMessage
} = require('./attendance-input-group');

async function main() {
  assert.strictEqual(
    INPUT_GROUP_NAME,
    'Palelu'
  );

  const palelu = {
    id: { _serialized: 'palelu@g.us' },
    name: 'Palelu',
    isGroup: true
  };

  assert.strictEqual(
    findPaleluGroup([
      {
        id: { _serialized: 'self@c.us' },
        name: 'Self',
        isGroup: false
      },
      {
        id: { _serialized: 'main@g.us' },
        name: 'Aktif Tim Magang OCN',
        isGroup: true
      },
      palelu
    ]).id,
    'palelu@g.us'
  );

  for (const invalid of [
    [],
    [
      { ...palelu, name: 'Other' }
    ],
    [
      palelu,
      { ...palelu, id: {
        _serialized: 'duplicate@g.us'
      } }
    ],
    [
      { ...palelu, isGroup: false }
    ],
    [
      { ...palelu, id: {
        _serialized: 'not-group@c.us'
      } }
    ]
  ]) {
    assert.throws(
      () => findPaleluGroup(invalid),
      /PALELU_GROUP_/
    );
  }

  const own = {
    fromMe: true,
    async getChat() {
      return palelu;
    }
  };

  assert.strictEqual(
    await isPaleluMessage(
      own,
      'palelu@g.us'
    ),
    true
  );

  const invalidMessages = [
    {
      fromMe: false,
      async getChat() {
        return palelu;
      }
    },
    {
      ...own,
      async getChat() {
        return {
          id: { _serialized: 'main@g.us' },
          name: 'Aktif Tim Magang OCN',
          isGroup: true
        };
      }
    },
    {
      ...own,
      async getChat() {
        return {
          id: { _serialized: 'self@c.us' },
          name: 'Self',
          isGroup: false
        };
      }
    },
    {
      ...own,
      async getChat() {
        return {
          ...palelu,
          name: 'Palelu changed'
        };
      }
    },
    {
      ...own,
      async getChat() {
        throw new Error('chat unavailable');
      }
    },
    null
  ];

  for (const message of invalidMessages) {
    assert.strictEqual(
      await isPaleluMessage(
        message,
        'palelu@g.us'
      ),
      false
    );
  }

  assert.strictEqual(
    await isPaleluMessage(
      own,
      'other@g.us'
    ),
    false
  );

  console.log('PALELU_EXACT_GROUP_TEST=PASS');
  console.log('PALELU_OWN_MESSAGE_ONLY=PASS');
  console.log('PALELU_SELF_CHAT_REJECTED=PASS');
  console.log('PALELU_MAIN_GROUP_REJECTED=PASS');
  console.log('WHATSAPP_MESSAGE_SENT=NO');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
