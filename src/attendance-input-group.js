'use strict';

// WA_AUTO_ABSENSI_PALELU_INPUT_SOURCE_V1
// Input group only. Does not send any WhatsApp messages.
const INPUT_GROUP_NAME = 'Palelu';

function serializedId(value) {
  if (typeof value === 'string') {
    return value;
  }

  return value &&
    typeof value._serialized === 'string'
    ? value._serialized
    : null;
}

function findPaleluGroup(chats) {
  if (!Array.isArray(chats)) {
    throw new Error(
      'PALELU_GROUP_LIST_INVALID'
    );
  }

  const matches = chats.filter(
    chat =>
      chat &&
      chat.isGroup === true &&
      typeof chat.name === 'string' &&
      chat.name.trim() === INPUT_GROUP_NAME
  );

  if (matches.length !== 1) {
    throw new Error(
      'PALELU_GROUP_MATCH_COUNT_' +
      matches.length
    );
  }

  const group = matches[0];
  const id = serializedId(group.id);

  if (!id || !id.endsWith('@g.us')) {
    throw new Error(
      'PALELU_GROUP_ID_INVALID'
    );
  }

  return {
    group,
    id
  };
}

async function isPaleluMessage(
  message,
  expectedGroupId
) {
  // Do not grant edit authority to other group members.
  if (
    !message ||
    message.fromMe !== true ||
    typeof expectedGroupId !== 'string' ||
    !expectedGroupId.endsWith('@g.us') ||
    typeof message.getChat !== 'function'
  ) {
    return false;
  }

  try {
    const chat = await message.getChat();

    return Boolean(
      chat &&
      chat.isGroup === true &&
      typeof chat.name === 'string' &&
      chat.name.trim() === INPUT_GROUP_NAME &&
      serializedId(chat.id) === expectedGroupId
    );
  } catch (_) {
    return false;
  }
}

module.exports = {
  INPUT_GROUP_NAME,
  findPaleluGroup,
  isPaleluMessage
};
