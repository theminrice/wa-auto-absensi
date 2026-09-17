function normalizeBody(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

async function findOutgoingDuplicate(
  chat,
  expectedBody,
  {
    limit = 100,
    requireMedia = false
  } = {}
) {
  const expected = normalizeBody(expectedBody);

  const messages = await chat.fetchMessages({
    limit,
    fromMe: true
  });

  const duplicate = messages.find(msg => {
    const sameBody =
      normalizeBody(msg.body) === expected;

    if (!sameBody) {
      return false;
    }

    if (requireMedia && !msg.hasMedia) {
      return false;
    }

    return true;
  });

  return {
    found: !!duplicate,
    message: duplicate || null,
    checked: messages.length
  };
}

module.exports = {
  findOutgoingDuplicate
};
