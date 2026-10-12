const { chromium } = require('playwright');
const fs = require('fs');

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const ACCOUNT_NAME = process.env.ACCOUNT_NAME || "Unknown";
const ACCOUNT_ID = process.env.ACCOUNT_ID || "A";

const STATE_FILE = `./claim_state_${ACCOUNT_ID}.json`;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getGameDay() {
  const now = new Date();
  const taiwanOffset = 8 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + taiwanOffset);
  const hour = local.getUTCHours();

  if (hour < 16) {
    local.setDate(local.getDate() - 1);
  }

  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}_16`;
}

async function notify(claimed, accountName, isSuccess) {
  if (!DISCORD_WEBHOOK) return;

  const payload = {
    embeds: [
      {
        title: isSuccess
          ? "🎮 荒野亂鬥自動領取成功"
          : "🎮 荒野亂鬥自動領取失敗",
        color: isSuccess ? 0x2ecc71 : 0xe74c3c,
        fields: [
          {
            name: "👤 帳號",
            value: accountName,
            inline: false
          },
          {
            name: "🎁 結果",
            value: isSuccess
              ? `成功領取 ${claimed} 個`
              : "沒有可領取獎勵（本次未成功）",
            inline: false
          }
        ],
        footer: {
          text: "GitHub Actions Auto Claim"
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  try {
    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.log("Discord notify failed");
  }
}

(async () => {
  const state = loadState();
  const gameDay = getGameDay();

  if (state.gameDay !== gameDay) {
    state.gameDay = gameDay;
    state.success = false;
    saveState(state);
  }

  if (state.success === true) {
    console.log(`😴 [${ACCOUNT_NAME}] 今日已成功，跳過`);
    return;
  }

  let claimed = 0;
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      storageState: 'auth.json'
    });

    const page = await context.newPage();

    await page.goto('https://store.supercell.com/brawlstars', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(8000);
    await page.waitForSelector('button', { timeout: 15000 }).catch(() => {});

    console.log(`👉 [${ACCOUNT_NAME}] 開始掃描`);

    const buttons = await page.$$('button');

    for (const btn of buttons) {
      let text = '';

      try {
        text = await btn.innerText();
      } catch {
        continue;
      }

      const normalizedText = text.trim().toLowerCase();
      const isClaimButton =
        normalizedText.includes('claim') ||
        normalizedText.includes('get') ||
        normalizedText.includes('領取') ||
        normalizedText.includes('免費') ||
        normalizedText.includes('免费') ||
        normalizedText.includes('free');

      if (isClaimButton) {
        console.log(`🔎 [${ACCOUNT_NAME}] 找到候選按鈕：${JSON.stringify(text.trim())}`);

        try {
          await btn.click({ timeout: 5000 });
          claimed++;
          console.log(`🟢 [${ACCOUNT_NAME}] 已點擊：${JSON.stringify(text.trim())}`);
          await page.waitForTimeout(1200);
        } catch (err) {
          console.log(`⚠️ [${ACCOUNT_NAME}] 點擊失敗：${JSON.stringify(text.trim())}；${err.message}`);
        }
      }
    }

    console.log(`✅ [${ACCOUNT_NAME}] 完成：${claimed}`);

    const isSuccess = claimed > 0;
    const checkedAt = new Date().toISOString();

    state.lastClaimAt = checkedAt;
    state.lastResult = isSuccess ? "成功" : "失敗";

    if (isSuccess) {
      state.success = true;
    }

    saveState(state);
    console.log(`RESULT=${isSuccess ? "success" : "failure"}`);
    await notify(claimed, ACCOUNT_NAME, isSuccess);

  } catch (err) {
    console.log("❌ error", err);

    state.lastClaimAt = new Date().toISOString();
    state.lastResult = "失敗";
    saveState(state);

    console.log("RESULT=failure");
    await notify(0, ACCOUNT_NAME, false);
  } finally {
    await browser.close();
  }
})();
