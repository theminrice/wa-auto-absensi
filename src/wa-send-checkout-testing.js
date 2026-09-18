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
  REMOTE_AUTH_SESSION,
  getRemoteAuthDataPath,
  getPuppeteerOptions,
  createMongoStore,
  createRemoteAuth
} = require('./remote-auth');

const {
  buildCheckOut
} = require('./attendance');

const {
  getLatestProject,
  getLatestDocumentationAfter,
  downloadDocumentation
} = require('./attendance-input-store');

const EXPECTED_GROUP_NAME = 'Testing';

// WA_AUTO_ABSENSI_DUAL_AUTH_V1
const useRemoteAuth =
  Boolean(process.env.MONGODB_URI);

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

async function isTestingUiActive(page) {
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
      .includes('Testing');
  });
}

async function waitTestingUiActive(
  page,
  timeoutMs
) {
  const deadline =
    Date.now() + timeoutMs;

  while (
    Date.now() < deadline
  ) {
    if (
      await isTestingUiActive(page)
    ) {
      return true;
    }

    await uiSleep(400);
  }

  return false;
}

async function clickTestingUiResult(page) {
  const handles =
    await page.$$(
      '[title="Testing"]'
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
          'UI_TESTING_RESULT_CLICKED=YES'
        );

        return true;
      }
    } catch (_) {}
  }

  return false;
}

async function findTestingSearchBox(page) {
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

async function openTestingUi(page) {
  console.log(
    'UI_OPEN_TESTING_START=YES'
  );

  await page.setViewport({
    width: 1440,
    height: 900
  });

  await page.bringToFront();

  if (
    await waitTestingUiActive(
      page,
      1500
    )
  ) {
    console.log(
      'UI_TESTING_ALREADY_ACTIVE=YES'
    );

    return;
  }

  if (
    await clickTestingUiResult(page)
  ) {
    if (
      await waitTestingUiActive(
        page,
        5000
      )
    ) {
      console.log(
        'UI_TESTING_CHAT_OPEN=YES'
      );

      return;
    }
  }

  const search =
    await findTestingSearchBox(page);

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
    'Testing',
    {
      delay: 2
    }
  );

  console.log(
    'UI_SEARCH_TESTING_TYPED=YES'
  );

  await uiSleep(2500);

  if (
    !await clickTestingUiResult(page)
  ) {
    throw new Error(
      'UI_TESTING_RESULT_NOT_FOUND'
    );
  }

  if (
    !await waitTestingUiActive(
      page,
      7000
    )
  ) {
    throw new Error(
      'UI_TESTING_NOT_ACTIVE'
    );
  }

  console.log(
    'UI_TESTING_CHAT_OPEN=YES'
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
  // WA_AUTO_ABSENSI_FOOTER_FILE_INPUT_FALLBACK_V1
  const deadline =
    Date.now() + 5000;

  while (Date.now() < deadline) {
    const handles =
      await page.$$(
        'footer input[type="file"]'
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
                Boolean(
                  el.closest(
                    'footer'
                  )
                ),

              hasImage:
                accept.includes(
                  'image'
                )
            };
          });

        if (
          info.inFooter &&
          !info.disabled &&
          info.hasImage
        ) {
          candidates.push({
            handle,
            info
          });
        }
      } catch (_) {}
    }

    console.log(
      `UI_FOOTER_FILE_INPUT_CANDIDATE_COUNT=${candidates.length}`
    );

    if (candidates.length > 1) {
      throw new Error(
        'UI_FOOTER_FILE_INPUT_NOT_UNIQUE'
      );
    }

    if (candidates.length === 1) {
      console.log(
        'UI_FOOTER_FILE_INPUT_FOUND=YES'
      );

      console.log(
        'UI_FOOTER_FILE_INPUT_ACCEPT=' +
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
    'UI_FOOTER_FILE_INPUT_NOT_FOUND'
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
    throw new Error(
      'UI_PHOTO_VIDEO_MENU_NOT_FOUND'
    );
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

async function sendCheckoutPhotoViaUi(
  client,
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
    await openTestingUi(page);

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

    const clickResult =
      await clickPhotoSendUi(
        page
      );

    clicked =
      clickResult.clicked === true;

    const previewClosed =
      await waitPhotoPreviewClosedUi(
        page,
        15000
      );

    /*
     * Never attempt another click after
     * the irreversible send action.
     */
    await uiSleep(5000);

    return {
      clicked,
      previewClosed,
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
  try {
    await client.destroy();
  } catch (_) {}

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

const targetGroupId = process.env.WA_TARGET_GROUP_ID;

console.log('============================================================');
console.log('WA AUTO ABSENSI - STEP 3.2');
console.log('SEND CHECK OUT + DOCUMENTATION IMAGE');
console.log('TESTING GROUP ONLY');
console.log('============================================================');

if (!targetGroupId) {
  console.error('TARGET_GROUP_ID_FOUND=NO');
  console.error('MESSAGE_SENT=NO');
  process.exit(10);
}

if (!targetGroupId.endsWith('@g.us')) {
  console.error('TARGET_GROUP_ID_VALID=NO');
  console.error('MESSAGE_SENT=NO');
  process.exit(11);
}

console.log('TARGET_GROUP_ID_FOUND=YES');
console.log(`TARGET_GROUP_ID_MASKED=${maskGroupId(targetGroupId)}`);

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

    const store =
      createMongoStore(
        mongoose,
        dataPath
      );

    console.log(
      'MONGO_STORE_READY=YES'
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
      createRemoteAuth(
        store,
        dataPath
      );

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

    const targetChat = await timeout(
      client.getChatById(targetGroupId),
      30000,
      'TARGET_GROUP_LOOKUP'
    );

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
    // 4. FIND DOCUMENTATION AFTER PROJECT
    // ========================================================

    const latestDocumentation =
      await timeout(
        getLatestDocumentationAfter(
          mongoose.connection,
          latestProject.createdAt
        ),
        30000,
        'GET_LATEST_DOCUMENTATION'
      );

    if (!latestDocumentation) {
      console.log('DOC_IMAGE_FOUND=NO');
      console.log('REASON=NO_IMAGE_p_AFTER_LATEST_PROJECT');
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
    console.log('DOC_IMAGE_PAIR_VALID=YES');

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

    console.log(
      'UI_SEND_COMMIT_CONFIRMED=YES'
    );

    console.log(
      'SERVER_ACK_CONFIRMED=NOT_AVAILABLE_UI_PATH'
    );

    console.log('MESSAGE_SENT=YES');
    console.log('MEDIA_SENT=YES');
    console.log('CAPTION_SENT=YES');
    console.log('TARGET_GROUP_CONFIRMED=Testing');

    console.log(
      `UI_SEND_CONTROL=${uiSend.sendLabel || 'UNKNOWN'}`
    );

    console.log(
      `SENT_TIMESTAMP=${uiSend.timestamp || 'UNKNOWN'}`
    );

    console.log('STEP_4_1E_CHECKOUT=PASS');

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