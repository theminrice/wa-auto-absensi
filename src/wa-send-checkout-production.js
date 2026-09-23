const qrcode = require('qrcode-terminal');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Client,
  LocalAuth,
  MessageMedia
} = require('whatsapp-web.js');

const mongoose = require('mongoose');

const {
  REMOTE_AUTH_V3_ACTIVE_SESSION: REMOTE_AUTH_SESSION,
  REMOTE_AUTH_V3_BACKUP_MS: REMOTE_AUTH_BACKUP_MS,
  getRemoteAuthDataPath,
  getPuppeteerOptions,
  createRemoteAuthV3
} = require('./remote-auth-v3');

const {
  buildCheckOut
} = require('./attendance');

const {
  getLatestProject,
  getLatestLeave,
  getLatestDocumentation,
  downloadDocumentation
} = require('./attendance-input-store');

const {
  evaluateLeaveForDate
} = require('./attendance-leave');

const EXPECTED_GROUP_NAME = 'Aktif Tim Magang OCN';

// WA_AUTO_ABSENSI_DUAL_AUTH_V1
const useRemoteAuth =
  Boolean(process.env.MONGODB_URI);

let remoteV3Store = null;

function timeout(promise, ms, label) {
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}_TIMEOUT_${ms}MS`)),
      ms
    );
  });

  return Promise.race([promise, timeoutPromise])
    .finally(() => clearTimeout(timer));
}

function maskGroupId(id) {
  if (!id || typeof id !== 'string') {
    return 'UNKNOWN';
  }

  const [left, suffix] = id.split('@');

  if (!left || !suffix) {
    return 'MASKED';
  }

  return `***${left.slice(-5)}@${suffix}`;
}



// WA_AUTO_ABSENSI_CHECKOUT_UI_PHOTO_V1
function normalizeUiText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200e\u200f]/g, '')
    .trim();
}

function toWhatsAppBulletCaption(caption) {
  return normalizeUiText(caption)
    .split('\n')
    .map(line =>
      line.startsWith('- ')
        ? `• ${line.slice(2)}`
        : line
    )
    .join('\n');
}

function imageExtensionFromMime(mimetype) {
  const raw =
    String(mimetype || '')
      .split(';')[0]
      .trim()
      .toLowerCase();

  const subtype =
    raw.startsWith('image/')
      ? raw.slice(6)
      : '';

  const map = {
    jpeg: 'jpg',
    jpg: 'jpg',
    png: 'png',
    webp: 'webp',
    gif: 'gif'
  };

  const extension =
    map[subtype];

  if (!extension) {
    throw new Error(
      `UNSUPPORTED_UI_PHOTO_MIMETYPE_${raw || 'UNKNOWN'}`
    );
  }

  return extension;
}

function uiSleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}

async function isProductionUiActive(page) {
  return await page.evaluate(() => {
    const main =
      document.querySelector('#main');

    if (!main) {
      return false;
    }

    const header =
      main.querySelector('header');

    if (!header) {
      return false;
    }

    return (
      header.innerText || ''
    )
      .split('\n')
      .map(value => value.trim())
      .includes('Aktif Tim Magang OCN');
  });
}

async function waitProductionUiActive(
  page,
  timeoutMs
) {
  const deadline =
    Date.now() + timeoutMs;

  while (
    Date.now() < deadline
  ) {
    if (
      await isProductionUiActive(page)
    ) {
      return true;
    }

    await uiSleep(400);
  }

  return false;
}

async function clickProductionUiResult(page) {
  const handles =
    await page.$$(
      '[title="Aktif Tim Magang OCN"]'
    );

  for (const handle of handles) {
    try {
      const info =
        await handle.evaluate(el => {
          const rect =
            el.getBoundingClientRect();

          return {
            visible:
              rect.width > 0 &&
              rect.height > 0,

            left:
              rect.left
          };
        });

      if (
        info.visible &&
        info.left < 650
      ) {
        await handle.click();

        console.log(
          'UI_PRODUCTION_RESULT_CLICKED=YES'
        );

        return true;
      }
    } catch (_) {}
  }

  return false;
}

async function findProductionSearchBox(page) {
  const handles =
    await page.$$(
      'div[contenteditable="true"],input'
    );

  for (const handle of handles) {
    try {
      const info =
        await handle.evaluate(el => {
          const rect =
            el.getBoundingClientRect();

          const style =
            getComputedStyle(el);

          const label =
            (
              (
                el.getAttribute(
                  'aria-label'
                ) || ''
              ) +
              ' ' +
              (
                el.getAttribute(
                  'placeholder'
                ) || ''
              ) +
              ' ' +
              (
                el.getAttribute(
                  'data-placeholder'
                ) || ''
              )
            ).toLowerCase();

          return {
            visible:
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden',

            left:
              rect.left,

            top:
              rect.top,

            label
          };
        });

      if (
        info.visible &&
        info.left < 650 &&
        info.top < 250 &&
        (
          info.label.includes(
            'search'
          ) ||
          info.label.includes(
            'cari'
          )
        )
      ) {
        return handle;
      }
    } catch (_) {}
  }

  return null;
}

async function openProductionUi(page) {
  console.log(
    'UI_OPEN_PRODUCTION_START=YES'
  );

  await page.setViewport({
    width: 1440,
    height: 900
  });

  await page.bringToFront();

  if (
    await waitProductionUiActive(
      page,
      1500
    )
  ) {
    console.log(
      'UI_PRODUCTION_ALREADY_ACTIVE=YES'
    );

    return;
  }

  if (
    await clickProductionUiResult(page)
  ) {
    if (
      await waitProductionUiActive(
        page,
        5000
      )
    ) {
      console.log(
        'UI_PRODUCTION_CHAT_OPEN=YES'
      );

      return;
    }
  }

  const search =
    await findProductionSearchBox(page);

  if (!search) {
    throw new Error(
      'UI_SEARCH_BOX_NOT_FOUND'
    );
  }

  await search.focus();

  await page.keyboard.down(
    'Control'
  );

  await page.keyboard.press(
    'A'
  );

  await page.keyboard.up(
    'Control'
  );

  await page.keyboard.press(
    'Backspace'
  );

  await page.keyboard.type(
    'Aktif Tim Magang OCN',
    {
      delay: 2
    }
  );

  console.log(
    'UI_SEARCH_PRODUCTION_TYPED=YES'
  );

  await uiSleep(2500);

  if (
    !await clickProductionUiResult(page)
  ) {
    throw new Error(
      'UI_PRODUCTION_RESULT_NOT_FOUND'
    );
  }

  if (
    !await waitProductionUiActive(
      page,
      7000
    )
  ) {
    throw new Error(
      'UI_PRODUCTION_NOT_ACTIVE'
    );
  }

  console.log(
    'UI_PRODUCTION_CHAT_OPEN=YES'
  );
}

async function findAttachmentUi(page) {
  const handles =
    await page.$$(
      'button,[role="button"]'
    );

  for (const handle of handles) {
    try {
      const info =
        await handle.evaluate(el => {
          const rect =
            el.getBoundingClientRect();

          const style =
            getComputedStyle(el);

          const aria =
            el.getAttribute(
              'aria-label'
            ) || '';

          const title =
            el.getAttribute(
              'title'
            ) || '';

          const text =
            (el.innerText || '')
              .trim();

          return {
            visible:
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden',

            aria,
            title,
            text,

            inFooter:
              Boolean(
                el.closest(
                  'footer'
                )
              )
          };
        });

      const haystack =
        (
          info.aria +
          ' ' +
          info.title +
          ' ' +
          info.text
        ).toLowerCase();

      if (
        info.visible &&
        info.inFooter &&
        (
          haystack.includes(
            'lampir'
          ) ||
          haystack.includes(
            'attach'
          )
        )
      ) {
        return handle;
      }
    } catch (_) {}
  }

  return null;
}

async function findPhotoVideoMenuUi(page) {
  for (
    let attempt = 1;
    attempt <= 30;
    attempt++
  ) {
    const handles =
      await page.$$(
        '[role="menuitem"],button,[role="button"]'
      );

    for (const handle of handles) {
      try {
        const info =
          await handle.evaluate(el => {
            const rect =
              el.getBoundingClientRect();

            const style =
              getComputedStyle(el);

            return {
              visible:
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden',

              aria:
                el.getAttribute(
                  'aria-label'
                ) || '',

              text:
                (el.innerText || '')
                  .replace(
                    /\s+/g,
                    ' '
                  )
                  .trim()
            };
          });

        if (!info.visible) {
          continue;
        }

        const aria =
          info.aria
            .toLowerCase();

        const text =
          info.text
            .toLowerCase();

        if (
          aria.includes(
            'foto & video'
          ) ||
          text ===
            'foto & video' ||
          aria.includes(
            'photos & videos'
          ) ||
          text ===
            'photos & videos' ||
          aria.includes(
            'photo & video'
          ) ||
          text ===
            'photo & video'
        ) {
          return handle;
        }
      } catch (_) {}
    }

    await uiSleep(300);
  }

  return null;
}

// WA_AUTO_ABSENSI_FILECHOOSER_FALLBACK_V1
async function markExistingFileInputsUi(page) {
  await page.evaluate(() => {
    for (
      const input of
      document.querySelectorAll(
        'input[type="file"]'
      )
    ) {
      input.setAttribute(
        'data-wa-auto-absensi-pre-photo',
        '1'
      );
    }
  });
}

async function uploadPhotoVideoFallbackUi(
  page,
  filePath
) {
  // WA_AUTO_ABSENSI_PHOTO_MENU_FALLBACK_V2
  // Fail closed: footer image input OR uniquely identified
  // image+video input (WhatsApp can portal it outside footer).
  const deadline =
    Date.now() + 5000;

  while (Date.now() < deadline) {
    const handles =
      await page.$$(
        'input[type="file"]'
      );

    const candidates = [];

    for (const handle of handles) {
      try {
        const info =
          await handle.evaluate(el => {
            const accept =
              (
                el.getAttribute(
                  'accept'
                ) || ''
              ).toLowerCase();

            return {
              accept,
              disabled:
                Boolean(el.disabled),
              inFooter:
                Boolean(el.closest(
                  'footer'
                )),
              hasImage:
                accept.includes(
                  'image/'
                ),
              hasVideo:
                accept.includes(
                  'video/'
                )
            };
          });

        if (
          !info.disabled &&
          info.hasImage &&
          (
            info.inFooter ||
            info.hasVideo
          )
        ) {
          candidates.push({
            handle,
            info
          });
        }
      } catch (_) {}
    }

    console.log(
      `UI_IMAGE_FILE_INPUT_CANDIDATE_COUNT=${candidates.length}`
    );

    if (candidates.length > 1) {
      throw new Error(
        'UI_IMAGE_FILE_INPUT_NOT_UNIQUE'
      );
    }

    if (candidates.length === 1) {
      if (
        !await isProductionUiActive(page)
      ) {
        throw new Error(
          'UI_PRODUCTION_NOT_ACTIVE_BEFORE_FALLBACK'
        );
      }

      console.log(
        'UI_IMAGE_FILE_INPUT_SOURCE=' +
        (
          candidates[0].info.inFooter
            ? 'FOOTER'
            : 'IMAGE_VIDEO'
        )
      );

      console.log(
        'UI_IMAGE_FILE_INPUT_ACCEPT=' +
        (
          candidates[0].info.accept ||
          'EMPTY'
        )
      );

      await candidates[0].handle.uploadFile(
        filePath
      );

      console.log(
        'UI_PHOTO_VIDEO_FILE_SELECTED_FALLBACK=YES'
      );

      return;
    }

    await uiSleep(250);
  }

  throw new Error(
    'UI_IMAGE_FILE_INPUT_NOT_FOUND'
  );
}
async function selectPhotoVideoUi(
  page,
  filePath
) {
  const attachment =
    await findAttachmentUi(page);

  if (!attachment) {
    throw new Error(
      'UI_ATTACHMENT_TRIGGER_NOT_FOUND'
    );
  }

  await attachment.click();

  console.log(
    'UI_ATTACHMENT_MENU_OPENED=YES'
  );

  const photoVideo =
    await findPhotoVideoMenuUi(
      page
    );

  if (!photoVideo) {
    console.log(
      'UI_PHOTO_VIDEO_MENU_FOUND=NO'
    );

    console.log(
      'UI_PHOTO_VIDEO_MENU_FALLBACK_START=YES'
    );

    try {
      await uploadPhotoVideoFallbackUi(
        page,
        filePath
      );
    } catch (error) {
      console.log(
        'UI_PHOTO_VIDEO_MENU_FALLBACK_ERROR=' +
        error.message
      );

      throw new Error(
        'UI_PHOTO_VIDEO_MENU_NOT_FOUND_' +
        error.message
      );
    }

    return;
  }

  console.log(
    'UI_PHOTO_VIDEO_MENU_FOUND=YES'
  );

  /*
   * Mark file inputs that already existed before
   * clicking the exact Foto & Video menu item.
   */
  await markExistingFileInputsUi(
    page
  );

  const chooserPromise =
    page.waitForFileChooser({
      timeout: 15000
    });

  await photoVideo.click();

  console.log(
    'UI_PHOTO_VIDEO_MENU_CLICKED=YES'
  );

  let chooser = null;

  try {
    chooser =
      await chooserPromise;
  } catch (error) {
    console.log(
      'UI_PHOTO_VIDEO_FILE_CHOOSER_FOUND=NO'
    );

    console.log(
      'UI_PHOTO_VIDEO_FILE_CHOOSER_FALLBACK_START=YES'
    );

    await uploadPhotoVideoFallbackUi(
      page,
      filePath
    );

    return;
  }

  console.log(
    'UI_PHOTO_VIDEO_FILE_CHOOSER_FOUND=YES'
  );

  await chooser.accept([
    filePath
  ]);

  console.log(
    'UI_PHOTO_VIDEO_FILE_SELECTED=YES'
  );
}
async function getPhotoPreviewUiState(page) {
  return await page.evaluate(() => {
    const visible =
      el => {
        if (!el) {
          return false;
        }

        const rect =
          el.getBoundingClientRect();

        const style =
          getComputedStyle(el);

        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      };

    const bodyText =
      document.body
        ? document.body.innerText || ''
        : '';

    const captionBoxes =
      Array.from(
        document.querySelectorAll(
          '[contenteditable="true"][role="textbox"]'
        )
      )
        .filter(el => {
          if (
            !visible(el) ||
            el.closest('footer')
          ) {
            return false;
          }

          const aria =
            (
              el.getAttribute(
                'aria-label'
              ) || ''
            ).toLowerCase();

          return (
            aria ===
              'ketik pesan' ||
            aria ===
              'type a message'
          );
        })
        .map(el => {
          const rect =
            el.getBoundingClientRect();

          return {
            aria:
              el.getAttribute(
                'aria-label'
              ) || '',

            text:
              el.innerText || '',

            x:
              Math.round(rect.x),

            y:
              Math.round(rect.y),

            width:
              Math.round(rect.width),

            height:
              Math.round(rect.height)
          };
        });

    const sendButtons =
      Array.from(
        document.querySelectorAll(
          '[role="button"][aria-label]'
        )
      )
        .filter(el => {
          if (!visible(el)) {
            return false;
          }

          const aria =
            (
              el.getAttribute(
                'aria-label'
              ) || ''
            ).toLowerCase();

          return (
            (
              aria.includes(
                'kirim'
              ) &&
              aria.includes(
                'dipilih'
              )
            ) ||
            (
              aria.includes(
                'send'
              ) &&
              aria.includes(
                'selected'
              )
            )
          );
        })
        .map(el =>
          el.getAttribute(
            'aria-label'
          ) || ''
        );

    const largeImages =
      Array.from(
        document.querySelectorAll(
          'img'
        )
      )
        .filter(visible)
        .filter(el => {
          const rect =
            el.getBoundingClientRect();

          return (
            rect.width >= 300 &&
            rect.height >= 200
          );
        });

    return {
      stickerMaker:
        bodyText.includes(
          'WhatsApp Sticker Maker'
        ),

      captionBoxCount:
        captionBoxes.length,

      captionBoxes,

      sendCount:
        sendButtons.length,

      sendLabels:
        sendButtons,

      largeImageCount:
        largeImages.length
    };
  });
}

async function waitPhotoPreviewUi(page) {
  for (
    let attempt = 1;
    attempt <= 40;
    attempt++
  ) {
    const state =
      await getPhotoPreviewUiState(
        page
      );

    if (
      attempt === 1 ||
      attempt % 5 === 0
    ) {
      console.log(
        `UI_PHOTO_PREVIEW_ATTEMPT=${attempt}`
      );

      console.log(
        'UI_PHOTO_PREVIEW_STATE=' +
        JSON.stringify(state)
      );
    }

    if (
      state.stickerMaker === false &&
      state.captionBoxCount === 1 &&
      state.sendCount === 1 &&
      state.largeImageCount >= 1
    ) {
      console.log(
        'UI_PHOTO_VIDEO_PATH_CONFIRMED=YES'
      );

      console.log(
        'UI_REAL_MEDIA_CAPTION_BOX_CONFIRMED=YES'
      );

      return state;
    }

    await uiSleep(500);
  }

  throw new Error(
    'UI_PHOTO_PREVIEW_NOT_CONFIRMED'
  );
}

async function getRealMediaCaptionBoxUi(page) {
  const boxes =
    await page.$$(
      '[contenteditable="true"][role="textbox"]'
    );

  const valid = [];

  for (const box of boxes) {
    try {
      const info =
        await box.evaluate(el => {
          const rect =
            el.getBoundingClientRect();

          const style =
            getComputedStyle(el);

          const aria =
            (
              el.getAttribute(
                'aria-label'
              ) || ''
            ).toLowerCase();

          return {
            visible:
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden',

            inFooter:
              Boolean(
                el.closest(
                  'footer'
                )
              ),

            aria
          };
        });

      if (
        info.visible &&
        info.inFooter === false &&
        (
          info.aria ===
            'ketik pesan' ||
          info.aria ===
            'type a message'
        )
      ) {
        valid.push(box);
      }
    } catch (_) {}
  }

  if (
    valid.length !== 1
  ) {
    throw new Error(
      'UI_REAL_MEDIA_CAPTION_BOX_NOT_UNIQUE'
    );
  }

  return valid[0];
}

async function insertMediaCaptionUi(
  page,
  finalCaption
) {
  const box =
    await getRealMediaCaptionBoxUi(
      page
    );

  const lines =
    finalCaption.split('\n');

  const bullets =
    lines.filter(
      line =>
        line.startsWith('• ')
    );

  if (
    lines.length !== 7 ||
    lines[1] !== '' ||
    bullets.length !== 5
  ) {
    throw new Error(
      'UI_CAPTION_STRUCTURE_INVALID'
    );
  }

  await box.focus();

  await page.keyboard.down(
    'Control'
  );

  await page.keyboard.press(
    'A'
  );

  await page.keyboard.up(
    'Control'
  );

  await page.keyboard.press(
    'Backspace'
  );

  await uiSleep(250);

  const session =
    await page.target()
      .createCDPSession();

  try {
    await session.send(
      'Input.insertText',
      {
        text:
          finalCaption
      }
    );
  } finally {
    try {
      await session.detach();
    } catch (_) {}
  }

  console.log(
    'UI_CDP_INSERT_TEXT_CALLED=YES'
  );

  console.log(
    'UI_ENTER_KEY_USED=NO'
  );

  await uiSleep(1200);

  const actual =
    normalizeUiText(
      await box.evaluate(
        el =>
          el.innerText || ''
      )
    );

  if (
    actual !==
    finalCaption
  ) {
    console.log(
      'UI_CAPTION_CDP_EXACT=NO'
    );

    throw new Error(
      'UI_CAPTION_MISMATCH_SEND_BLOCKED'
    );
  }

  console.log(
    'UI_CAPTION_CDP_EXACT=YES'
  );
}

async function finalPhotoUiGuard(
  page,
  finalCaption
) {
  const state =
    await getPhotoPreviewUiState(
      page
    );

  if (
    state.stickerMaker !== false
  ) {
    throw new Error(
      'UI_STICKER_MAKER_GUARD_BLOCK'
    );
  }

  if (
    state.captionBoxCount !== 1 ||
    state.sendCount !== 1 ||
    state.largeImageCount < 1
  ) {
    throw new Error(
      'UI_FINAL_PHOTO_PREVIEW_GUARD_BLOCK'
    );
  }

  if (
    normalizeUiText(
      state.captionBoxes[0].text
    ) !==
    finalCaption
  ) {
    throw new Error(
      'UI_FINAL_CAPTION_CHANGED_SEND_BLOCKED'
    );
  }

  console.log(
    'UI_FINAL_CAPTION_EXACT=YES'
  );

  console.log(
    'UI_FINAL_PHOTO_PREVIEW_GUARD=PASS'
  );

  console.log(
    'UI_STICKER_MAKER_VISIBLE=NO'
  );
}

async function clickPhotoSendUi(page) {
  const result =
    await page.evaluate(() => {
      const visible =
        el => {
          if (!el) {
            return false;
          }

          const rect =
            el.getBoundingClientRect();

          const style =
            getComputedStyle(el);

          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        };

      const buttons =
        Array.from(
          document.querySelectorAll(
            '[role="button"][aria-label]'
          )
        )
          .filter(el => {
            if (!visible(el)) {
              return false;
            }

            const aria =
              (
                el.getAttribute(
                  'aria-label'
                ) || ''
              ).toLowerCase();

            return (
              (
                aria.includes(
                  'kirim'
                ) &&
                aria.includes(
                  'dipilih'
                )
              ) ||
              (
                aria.includes(
                  'send'
                ) &&
                aria.includes(
                  'selected'
                )
              )
            );
          });

      if (
        buttons.length !== 1
      ) {
        return {
          clicked: false,
          count:
            buttons.length
        };
      }

      const label =
        buttons[0].getAttribute(
          'aria-label'
        ) || '';

      buttons[0].click();

      return {
        clicked: true,
        count: 1,
        label
      };
    });

  if (
    result.clicked !== true
  ) {
    throw new Error(
      'UI_PHOTO_SEND_CLICK_FAILED'
    );
  }

  console.log(
    'UI_PHOTO_SEND_BUTTON_CLICKED=YES'
  );

  console.log(
    'UI_REAL_PHOTO_SEND_TRIGGERED=YES'
  );

  return result;
}

async function waitPhotoPreviewClosedUi(
  page,
  timeoutMs
) {
  const deadline =
    Date.now() + timeoutMs;

  while (
    Date.now() < deadline
  ) {
    const state =
      await getPhotoPreviewUiState(
        page
      );

    if (
      state.captionBoxCount === 0 &&
      state.sendCount === 0
    ) {
      console.log(
        'UI_PHOTO_PREVIEW_CLOSED_AFTER_CLICK=YES'
      );

      return true;
    }

    await uiSleep(500);
  }

  console.log(
    'UI_PHOTO_PREVIEW_CLOSED_AFTER_CLICK=NO'
  );

  return false;
}

// WA_AUTO_ABSENSI_CHECKOUT_POST_SEND_ACK_HOLD_V1
function checkoutOutgoingMessageKey(message) {
  const serialized =
    message &&
    message.id &&
    typeof message.id._serialized === 'string'
      ? message.id._serialized
      : '';

  if (serialized) {
    return serialized;
  }

  return [
    Number(message && message.timestamp || 0),
    normalizeUiText(message && message.body),
    message && message.hasMedia === true ? '1' : '0'
  ].join(':');
}

async function getMatchingOutgoingCheckoutMessages(
  chat,
  expectedCaption,
  limit = 100
) {
  const expected =
    normalizeUiText(expectedCaption);

  const messages =
    await chat.fetchMessages({
      limit,
      fromMe: true
    });

  return messages.filter(message =>
    normalizeUiText(message.body) === expected &&
    message.hasMedia === true
  );
}

async function waitNewCheckoutOutgoingServerAck(
  chat,
  expectedCaption,
  baselineKeys,
  timeoutMs
) {
  const deadline =
    Date.now() + timeoutMs;

  let highestAck = -1;
  let newMessageSeen = false;

  while (Date.now() < deadline) {
    try {
      const matches =
        await getMatchingOutgoingCheckoutMessages(
          chat,
          expectedCaption,
          40
        );

      for (const message of matches) {
        const key =
          checkoutOutgoingMessageKey(
            message
          );

        if (baselineKeys.has(key)) {
          continue;
        }

        newMessageSeen = true;

        const ack =
          Number(message.ack ?? 0);

        if (ack > highestAck) {
          highestAck = ack;

          console.log(
            `CHECKOUT_NEW_MESSAGE_ACK_CURRENT=${ack}`
          );
        }

        if (ack >= 1) {
          console.log(
            'CHECKOUT_NEW_MESSAGE_FOUND=YES'
          );

          console.log(
            `CHECKOUT_SERVER_ACK_VALUE=${ack}`
          );

          return {
            confirmed: true,
            ack,
            key
          };
        }
      }
    } catch (error) {
      console.log(
        `CHECKOUT_ACK_FETCH_ERROR=${error.message}`
      );
    }

    await uiSleep(1000);
  }

  console.log(
    `CHECKOUT_NEW_MESSAGE_SEEN=${
      newMessageSeen ? 'YES' : 'NO'
    }`
  );

  console.log(
    `CHECKOUT_SERVER_ACK_HIGHEST=${highestAck}`
  );

  console.log(
    'CHECKOUT_SERVER_ACK_CONFIRMED=NO'
  );

  return {
    confirmed: false,
    ack: highestAck,
    key: ''
  };
}

async function sendCheckoutPhotoViaUi(
  client,
  targetChat,
  media,
  caption
) {
  const page =
    client.pupPage;

  if (!page) {
    throw new Error(
      'UI_PUPPAGE_NOT_AVAILABLE'
    );
  }

  if (
    !media ||
    typeof media.data !== 'string' ||
    !media.data
  ) {
    throw new Error(
      'UI_MEDIA_DATA_INVALID'
    );
  }

  if (
    !String(
      media.mimetype || ''
    ).startsWith('image/')
  ) {
    throw new Error(
      'UI_MEDIA_NOT_IMAGE'
    );
  }

  const finalCaption =
    toWhatsAppBulletCaption(
      caption
    );

  const bytes =
    Buffer.from(
      media.data,
      'base64'
    );

  if (!bytes.length) {
    throw new Error(
      'UI_MEDIA_BYTES_EMPTY'
    );
  }

  const extension =
    imageExtensionFromMime(
      media.mimetype
    );

  const filePath =
    path.join(
      os.tmpdir(),
      `wa-auto-absensi-checkout-${process.pid}-${Date.now()}.${extension}`
    );

  fs.writeFileSync(
    filePath,
    bytes
  );

  console.log(
    `UI_TEMP_IMAGE_BYTES=${bytes.length}`
  );

  let clicked = false;

  try {
    await openProductionUi(page);

    await selectPhotoVideoUi(
      page,
      filePath
    );

    await waitPhotoPreviewUi(
      page
    );

    await insertMediaCaptionUi(
      page,
      finalCaption
    );

    await finalPhotoUiGuard(
      page,
      finalCaption
    );

    const baselineMatches =
      await getMatchingOutgoingCheckoutMessages(
        targetChat,
        finalCaption,
        100
      );

    const baselineKeys =
      new Set(
        baselineMatches.map(
          checkoutOutgoingMessageKey
        )
      );

    console.log(
      `CHECKOUT_BASELINE_MATCH_COUNT=${baselineKeys.size}`
    );

    const clickResult =
      await clickPhotoSendUi(
        page
      );

    clicked =
      clickResult.clicked === true;

    const clickedAtMs =
      Date.now();

    const previewClosed =
      await waitPhotoPreviewClosedUi(
        page,
        15000
      );

    /*
     * Never attempt another click after
     * the irreversible send action.
     *
     * Keep the client alive until the new
     * checkout media message receives a
     * server ACK and at least one RemoteAuth
     * backup interval can elapse after click.
     */
    let serverAck = {
      confirmed: false,
      ack: -1,
      key: ''
    };

    if (previewClosed) {
      serverAck =
        await waitNewCheckoutOutgoingServerAck(
          targetChat,
          finalCaption,
          baselineKeys,
          45000
        );
    }

    const postSendHoldTargetMs =
      useRemoteAuth
        ? REMOTE_AUTH_BACKUP_MS + 5000
        : 15000;

    const elapsedAfterClickMs =
      Date.now() - clickedAtMs;

    const postSendHoldRemainingMs =
      Math.max(
        0,
        postSendHoldTargetMs -
          elapsedAfterClickMs
      );

    console.log(
      `POST_SEND_HOLD_TARGET_MS=${postSendHoldTargetMs}`
    );

    console.log(
      `POST_SEND_HOLD_REMAINING_MS=${postSendHoldRemainingMs}`
    );

    if (postSendHoldRemainingMs > 0) {
      await uiSleep(
        postSendHoldRemainingMs
      );
    }

    console.log(
      'POST_SEND_HOLD_DONE=YES'
    );

    return {
      clicked,
      previewClosed,
      serverAckConfirmed:
        serverAck.confirmed === true,
      serverAckValue:
        Number(serverAck.ack ?? -1),
      finalCaption,
      sendLabel:
        clickResult.label || '',
      timestamp:
        new Date().toISOString()
    };
  } finally {
    try {
      fs.unlinkSync(
        filePath
      );

      console.log(
        'UI_TEMP_IMAGE_REMOVED=YES'
      );
    } catch (_) {}

    if (clicked) {
      console.log(
        'UI_PHOTO_SEND_CLICKED_FINAL=YES'
      );
    }
  }
}

async function finish(client, code) {
  let drainOk = true;

  if (
    useRemoteAuth &&
    remoteV3Store &&
    typeof remoteV3Store.beginShutdownAndDrain ===
      'function'
  ) {
    try {
      await timeout(
        remoteV3Store.beginShutdownAndDrain(),
        120000,
        'REMOTE_V3_SHUTDOWN_DRAIN'
      );

      console.log(
        'REMOTE_V3_SHUTDOWN_DRAIN=PASS'
      );
    } catch (error) {
      drainOk = false;

      console.log(
        'REMOTE_V3_SHUTDOWN_DRAIN=FAIL'
      );

      console.log(
        'REMOTE_V3_SHUTDOWN_DRAIN_ERROR=' +
        error.message
      );

      if (code === 0) {
        code = 90;
      }
    }
  }

  if (drainOk) {
    try {
      await client.destroy();

      console.log(
        'CLIENT_DESTROYED=YES'
      );
    } catch (_) {}
  } else {
    console.log(
      'CLIENT_DESTROY_SKIPPED_DRAIN_FAIL=YES'
    );
  }

  if (
    useRemoteAuth &&
    mongoose.connection.readyState !== 0
  ) {
    try {
      await mongoose.disconnect();

      console.log(
        'MONGOOSE_DISCONNECTED=YES'
      );
    } catch (_) {}
  }

  process.exit(code);
}

console.log('TARGET_GROUP_DISCOVERY_MODE=EXACT_NAME');
console.log(`EXPECTED_GROUP_NAME=${EXPECTED_GROUP_NAME}`);

async function main() {
  let authStrategy;
  let puppeteerOptions;

  if (useRemoteAuth) {
    const uri =
      process.env.MONGODB_URI;

    const dataPath =
      getRemoteAuthDataPath();

    await mongoose.connect(
      uri,
      {
        dbName: 'wa_auto_absensi',
        serverSelectionTimeoutMS: 15000
      }
    );

    console.log(
      'MONGODB_CONNECTED=YES'
    );

    const remoteV3 =
      createRemoteAuthV3(
        mongoose,
        dataPath
      );

    const store =
      remoteV3.store;

    remoteV3Store =
      store;

    console.log(
      'MONGO_STORE_READY=YES'
    );

    console.log(
      'REMOTE_AUTH_VERSION=V3'
    );

    const remoteSessionExists =
      await store.sessionExists({
        session:
          REMOTE_AUTH_SESSION
      });

    console.log(
      `REMOTE_SESSION_EXISTS_BEFORE=${
        remoteSessionExists ? 'YES' : 'NO'
      }`
    );

    if (!remoteSessionExists) {
      throw new Error(
        'REMOTE_SESSION_MISSING'
      );
    }

    authStrategy =
      remoteV3.authStrategy;

    puppeteerOptions =
      getPuppeteerOptions();

    console.log(
      'AUTH_MODE=REMOTE'
    );
  }
  else {
    authStrategy =
      new LocalAuth({
        clientId:
          'wa-auto-absensi'
      });

    puppeteerOptions = {
      headless: true,
      protocolTimeout: 120000
    };

    console.log(
      'AUTH_MODE=LOCAL'
    );
  }

  const client =
    new Client({
      authStrategy,
      puppeteer:
        puppeteerOptions
    });

  client.on('qr', async qr => {
    console.log(
      'QR_RECEIVED=YES'
    );

    if (useRemoteAuth) {
      console.log(
        'REMOTE_AUTH_QR_FORBIDDEN=YES'
      );

      console.log(
        'MESSAGE_SENT=NO'
      );

      await finish(
        client,
        20
      );

      return;
    }

    qrcode.generate(
      qr,
      { small: true }
    );
  });

client.on('authenticated', () => {
  console.log('AUTHENTICATED=YES');
});

client.on('auth_failure', async msg => {
  console.error('AUTH_FAILURE=YES');
  console.error(msg);

  await finish(client, 1);
});

let attendanceReadyStarted = false;

// SIGASSPOL_READY_REENTRY_GUARD_V1
client.on('ready', async () => {
  if (attendanceReadyStarted) {
    console.log('READY_REENTRY_IGNORED=YES');
    return;
  }

  attendanceReadyStarted = true;

  console.log('WHATSAPP_READY=YES');

// REMOTE_POST_READY_SETTLE_V1
if (process.env.MONGODB_URI) {
  const remoteSettleMs = 15000;

  console.log(`REMOTE_POST_READY_SETTLE_MS=${remoteSettleMs}`);

  await new Promise(resolve =>
    setTimeout(resolve, remoteSettleMs)
  );

  console.log('REMOTE_POST_READY_SETTLE_DONE=YES');
}

  try {

    // ========================================================
    // 1. VERIFY TARGET = TESTING
    // ========================================================

    console.log('TARGET_GROUP_VERIFY_START=YES');

    const chats = await timeout(
      client.getChats(),
      30000,
      'TARGET_GROUP_LIST'
    );

    const targetMatches = chats.filter(
      chat =>
        chat &&
        chat.isGroup &&
        typeof chat.name === 'string' &&
        chat.name.trim().toLowerCase() ===
          EXPECTED_GROUP_NAME.toLowerCase()
    );

    console.log(
      `TARGET_GROUP_NAME_MATCH_COUNT=${targetMatches.length}`
    );

    const targetChat =
      targetMatches.length === 1
        ? targetMatches[0]
        : null;

    const targetGroupId =
      targetChat?.id?._serialized || '';

    if (targetGroupId) {
      console.log('TARGET_GROUP_ID_FOUND=YES');
      console.log(
        `TARGET_GROUP_ID_MASKED=${maskGroupId(targetGroupId)}`
      );
    } else {
      console.log('TARGET_GROUP_ID_FOUND=NO');
    }

    if (
      targetGroupId &&
      !targetGroupId.endsWith('@g.us')
    ) {
      console.log('TARGET_GROUP_ID_VALID=NO');
      console.log('MESSAGE_SENT=NO');
      return await finish(client, 23);
    }

    if (targetGroupId) {
      console.log('TARGET_GROUP_ID_VALID=YES');
    }

    if (!targetChat) {
      console.log('TARGET_GROUP_FOUND=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 20);
    }

    console.log('TARGET_GROUP_FOUND=YES');
    console.log(`TARGET_GROUP_NAME=${targetChat.name}`);
    console.log(`TARGET_GROUP_IS_GROUP=${targetChat.isGroup}`);

    if (!targetChat.isGroup) {
      console.log('TARGET_GROUP_SAFE=NO');
      console.log('REASON=TARGET_IS_NOT_GROUP');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 21);
    }

    if (
      typeof targetChat.name !== 'string' ||
      targetChat.name.trim().toLowerCase() !==
        EXPECTED_GROUP_NAME.toLowerCase()
    ) {
      console.log('TARGET_GROUP_SAFE=NO');
      console.log('REASON=GROUP_NAME_MISMATCH');
      console.log(`EXPECTED_GROUP_NAME=${EXPECTED_GROUP_NAME}`);
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 22);
    }

    console.log('TARGET_GROUP_SAFE=YES');

    // ========================================================
    // 2. READ ATTENDANCE INPUT FROM MONGODB
    // ========================================================

    // ATTENDANCE_INPUT_MONGODB_V1
    if (
      mongoose.connection.readyState !== 1
    ) {
      console.log('ATTENDANCE_INPUT_STORE_READY=NO');
      console.log('REASON=MONGODB_CONNECTION_REQUIRED');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 36);
    }

    console.log('ATTENDANCE_INPUT_STORE_READY=YES');

    // ATTENDANCE_LEAVE_SAFE_SKIP_V1
    // Read leave from MongoDB before project/media/send.
    const leaveDocument =
      await timeout(
        getLatestLeave(
          mongoose.connection
        ),
        30000,
        'GET_LATEST_LEAVE'
      );

    const leaveStatus =
      evaluateLeaveForDate(
        leaveDocument,
        new Date()
      );

    console.log(
      'LEAVE_CHECK_DATE=' +
      leaveStatus.dateKey
    );

    console.log(
      'LEAVE_PLAN_FOUND=' +
      (leaveDocument ? 'YES' : 'NO')
    );

    if (leaveDocument) {
      console.log(
        'LEAVE_START_DATE=' +
        leaveDocument.startDate
      );

      console.log(
        'LEAVE_END_DATE=' +
        leaveDocument.endDate
      );
    }

    if (leaveStatus.onLeave) {
      console.log(
        'LEAVE_TODAY=YES'
      );

      console.log(
        'ATTENDANCE_LEAVE_SKIP=YES'
      );

      console.log(
        'REASON=LEAVE_DATE'
      );

      console.log(
        'ACTION=SKIP'
      );

      console.log(
        'MESSAGE_SENT=NO'
      );

      console.log(
        'STEP_PRODUCTION_CHECKOUT=SKIPPED_LEAVE'
      );

      return await finish(client, 0);
    }

    console.log(
      'LEAVE_TODAY=NO'
    );

    // ========================================================
    // 3. FIND LATEST PROJECT
    // ========================================================

    const latestProject =
      await timeout(
        getLatestProject(
          mongoose.connection
        ),
        30000,
        'GET_LATEST_PROJECT'
      );

    if (
      !latestProject ||
      typeof latestProject.project !== 'string' ||
      !latestProject.project.trim() ||
      !(latestProject.createdAt instanceof Date)
    ) {
      console.log('PROJECT_FOUND=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 32);
    }

    console.log('PROJECT_FOUND=YES');
    console.log(`PROJECT=${latestProject.project}`);
    console.log(
      `PROJECT_TIMESTAMP=${latestProject.createdAt.toISOString()}`
    );

    // ========================================================
    // 4. FIND THE LATEST AVAILABLE DOCUMENTATION
    // ========================================================

    const latestDocumentation =
      await timeout(
        getLatestDocumentation(
          mongoose.connection
        ),
        30000,
        'GET_LATEST_DOCUMENTATION'
      );

    if (!latestDocumentation) {
      console.log('DOC_IMAGE_FOUND=NO');
      console.log('REASON=NO_AVAILABLE_DOCUMENTATION');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 33);
    }

    console.log('DOC_IMAGE_FOUND=YES');
    console.log(
      `DOC_IMAGE_TIMESTAMP=${
        latestDocumentation.createdAt instanceof Date
          ? latestDocumentation.createdAt.toISOString()
          : 'UNKNOWN'
      }`
    );
    // WA_AUTO_ABSENSI_CHECKOUT_LATEST_AVAILABLE_DOCUMENTATION_V2
    // Palelu sync runs before this sender. Accept the latest canonical
    // photo even if it is from a previous day or precedes the project.
    // This does not prove newer, unsynced Palelu photos do not exist.
    console.log('DOC_IMAGE_SELECTION=LATEST_AVAILABLE_CANONICAL');
    console.log('DOC_IMAGE_AGE_RESTRICTION=NONE');
    console.log('DOC_IMAGE_SELECTED=YES');

    // ========================================================
    // 5. DOWNLOAD DOCUMENTATION FROM GRIDFS
    // ========================================================

    console.log('DOWNLOAD_MEDIA_START=YES');

    const documentationBuffer =
      await timeout(
        downloadDocumentation(
          mongoose.connection,
          latestDocumentation
        ),
        120000,
        'DOWNLOAD_DOCUMENTATION'
      );

    if (
      !Buffer.isBuffer(documentationBuffer) ||
      documentationBuffer.length === 0
    ) {
      console.log('DOWNLOAD_MEDIA_SUCCESS=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 34);
    }

    console.log('DOWNLOAD_MEDIA_SUCCESS=YES');

    const documentationMime =
      latestDocumentation.mimetype;

    console.log(
      `DOCUMENTATION_MIMETYPE=${documentationMime || 'UNKNOWN'}`
    );

    if (
      typeof documentationMime !== 'string' ||
      !documentationMime.startsWith('image/')
    ) {
      console.log('DOCUMENTATION_VALID_IMAGE=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 35);
    }

    console.log('DOCUMENTATION_VALID_IMAGE=YES');

    const metadataSize =
      Number(latestDocumentation.size);

    if (
      Number.isFinite(metadataSize) &&
      metadataSize > 0 &&
      metadataSize !== documentationBuffer.length
    ) {
      console.log('DOCUMENTATION_SIZE_MATCH=NO');
      console.log('MESSAGE_SENT=NO');

      return await finish(client, 34);
    }

    console.log('DOCUMENTATION_SIZE_MATCH=YES');
    console.log(
      `DOCUMENTATION_SIZE=${documentationBuffer.length}`
    );

    const downloaded = {
      mimetype: documentationMime,
      data: documentationBuffer.toString(
        'base64'
      ),
      filename:
        typeof latestDocumentation.filename ===
          'string' &&
        latestDocumentation.filename.trim()
          ? latestDocumentation.filename.trim()
          : 'dokumentasi.jpg'
    };

    // ========================================================
    // 6. BUILD CHECK OUT CAPTION
    // ========================================================
    const caption = buildCheckOut({
      project: latestProject.project,
      date: new Date()
    });

    console.log('');
    console.log('CAPTION_PREVIEW_BEGIN');
    console.log(caption);
    console.log('CAPTION_PREVIEW_END');
    console.log('');

    // ========================================================
    // 7. PREPARE IMAGE
    // ========================================================

    const media = new MessageMedia(
      downloaded.mimetype,
      downloaded.data,
      downloaded.filename || 'dokumentasi.jpg'
    );

    // ========================================================
    // 8. SEND IMAGE + CAPTION TO TESTING
    // ========================================================

    const uiCaption =
      toWhatsAppBulletCaption(
        caption
      );

    console.log(
      'CAPTION_UI_FORMAT=BULLET'
    );

    // WA_AUTO_ABSENSI_CHECKOUT_NO_DUPLICATE_GUARD_V1
    console.log('CHECKOUT_DUPLICATE_GUARD=DISABLED');
    console.log('ACTION=SEND');
    console.log('SEND_START=YES');
    console.log('SEND_MODE=UI_PHOTO_VIDEO');

    const uiSend = await timeout(
      sendCheckoutPhotoViaUi(
        client,
        targetChat,
        media,
        uiCaption
      ),
      120000,
      'SEND_CHECKOUT_UI_PHOTO'
    );

    if (
      !uiSend ||
      uiSend.clicked !== true
    ) {
      console.log('MESSAGE_SENT=NO');
      console.log('MEDIA_SENT=NO');
      console.log('CAPTION_SENT=NO');
      console.log('STEP_4_1E_CHECKOUT=FAIL');

      return await finish(client, 40);
    }

    /*
     * The selected-media send click is irreversible.
     * Never retry inside this run.
     *
     * If the preview does not close, treat delivery
     * as unknown rather than clicking Send again.
     */
    if (
      uiSend.previewClosed !== true
    ) {
      console.log(
        'UI_SEND_COMMIT_CONFIRMED=NO'
      );

      console.log(
        'SERVER_ACK_CONFIRMED=NOT_AVAILABLE_UI_PATH'
      );

      console.log(
        'MESSAGE_SENT=UNKNOWN'
      );

      console.log(
        'MEDIA_SENT=UNKNOWN'
      );

      console.log(
        'CAPTION_SENT=UNKNOWN'
      );

      console.log(
        'STEP_4_1E_CHECKOUT=FAIL'
      );

      await new Promise(
        resolve =>
          setTimeout(resolve, 5000)
      );

      return await finish(
        client,
        42
      );
    }

    if (
      uiSend.serverAckConfirmed !== true
    ) {
      console.log(
        'UI_SEND_COMMIT_CONFIRMED=UNKNOWN'
      );

      console.log(
        'SERVER_ACK_CONFIRMED=NO'
      );

      console.log(
        `SERVER_ACK_VALUE=${uiSend.serverAckValue}`
      );

      console.log(
        'MESSAGE_SENT=UNKNOWN'
      );

      console.log(
        'MEDIA_SENT=UNKNOWN'
      );

      console.log(
        'CAPTION_SENT=UNKNOWN'
      );

      console.log(
        'STEP_4_1E_CHECKOUT=FAIL'
      );

      return await finish(
        client,
        43
      );
    }

    console.log(
      'UI_SEND_COMMIT_CONFIRMED=YES'
    );

    console.log(
      'SERVER_ACK_CONFIRMED=YES'
    );

    console.log(
      `SERVER_ACK_VALUE=${uiSend.serverAckValue}`
    );

    console.log('MESSAGE_SENT=YES');
    console.log('MEDIA_SENT=YES');
    console.log('CAPTION_SENT=YES');
    console.log('TARGET_GROUP_CONFIRMED=Aktif Tim Magang OCN');

    console.log(
      `UI_SEND_CONTROL=${uiSend.sendLabel || 'UNKNOWN'}`
    );

    console.log(
      `SENT_TIMESTAMP=${uiSend.timestamp || 'UNKNOWN'}`
    );

    console.log('STEP_PRODUCTION_CHECKOUT=PASS');

    await new Promise(
      resolve =>
        setTimeout(resolve, 3000)
    );

    await finish(client, 0);

  } catch (error) {
    console.error('CHECKOUT_SEND_ERROR=YES');
    console.error(error);
    console.log('MESSAGE_SENT=UNKNOWN');

    await finish(client, 1);
  }
});

client.on('disconnected', reason => {
  console.log(`WHATSAPP_DISCONNECTED=${reason}`);
});
  await client.initialize();
}

main().catch(async error => {
  console.error(
    'SENDER_STARTUP_ERROR=YES'
  );

  console.error(error);

  console.log(
    'MESSAGE_SENT=NO'
  );

  if (
    useRemoteAuth &&
    mongoose.connection.readyState !== 0
  ) {
    try {
      await mongoose.disconnect();

      console.log(
        'MONGOOSE_DISCONNECTED=YES'
      );
    } catch (_) {}
  }

  process.exit(1);
});