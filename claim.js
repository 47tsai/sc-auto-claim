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
              : claimed > 0
              ? `已點擊 ${claimed} 個，但頁面未能完整掃描或有按鈕點擊失敗`
              : "沒有成功點擊可領取獎勵",
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
    state.fullScan = false;
    saveState(state);
  }

  if (state.success === true && state.fullScan === true) {
    console.log(`😴 [${ACCOUNT_NAME}] 今日已完成完整掃描並成功，跳過`);
    return;
  }

  // 舊版只要點到一個按鈕就會記為成功，不能讓這種紀錄阻止新版補領。
  if (state.success === true && state.fullScan !== true) {
    console.log(`🔁 [${ACCOUNT_NAME}] 發現舊版成功紀錄，重新完整掃描以補領剩餘內容`);
    state.success = false;
    saveState(state);
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

    console.log(`👉 [${ACCOUNT_NAME}] 開始完整掃描頁面`);

    const MAX_SCAN_STEPS = 150;
    let failedClicks = 0;
    let scrollSteps = 0;
    let stableBottomRounds = 0;
    let previousHeight = 0;
    let scanCompleted = false;
    const attemptedKeys = new Set();

    for (let step = 0; step < MAX_SCAN_STEPS; step++) {
      let clickedThisRound = false;
      const buttons = await page.$$('button');

      for (const btn of buttons) {
        let text = '';

        try {
          text = (await btn.innerText()).trim();
          if (!text || !(await btn.isVisible()) || !(await btn.isEnabled())) {
            continue;
          }
        } catch {
          continue;
        }

        const normalizedText = text.toLowerCase();
        const isClaimButton =
          normalizedText.includes('claim') ||
          normalizedText.includes('get') ||
          normalizedText.includes('領取') ||
          normalizedText.includes('免費') ||
          normalizedText.includes('免费') ||
          normalizedText.includes('free');

        if (!isClaimButton) continue;

        let key = text;
        try {
          key = await btn.evaluate((el) => {
            const buttonText = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
            const context = el.closest('article, li, [role="listitem"], [data-testid]') ||
              el.parentElement?.parentElement ||
              el.parentElement;
            const contextText = (context?.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 300);
            return [buttonText, el.getAttribute('aria-label') || '', contextText].join('|');
          });
        } catch {}

        if (attemptedKeys.has(key)) continue;
        attemptedKeys.add(key);

        console.log(`🔎 [${ACCOUNT_NAME}] 找到候選按鈕：${JSON.stringify(text)}`);

        try {
          await btn.click({ timeout: 5000 });
          claimed++;
          console.log(`🟢 [${ACCOUNT_NAME}] 已點擊：${JSON.stringify(text)}（累計 ${claimed}）`);
          clickedThisRound = true;
          await page.waitForTimeout(1500);
          break;
        } catch (err) {
          failedClicks++;
          console.log(`⚠️ [${ACCOUNT_NAME}] 點擊失敗：${JSON.stringify(text)}；${err.message}`);
        }
      }

      // 每次成功點擊後重新掃描，避免頁面更新或按鈕重排造成漏領。
      if (clickedThisRound) continue;

      const metrics = await page.evaluate(() => {
        const height = Math.max(
          document.body?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0
        );
        return {
          y: window.scrollY,
          viewport: window.innerHeight,
          height
        };
      });

      const atBottom = metrics.y + metrics.viewport >= metrics.height - 8;
      if (atBottom && metrics.height === previousHeight) {
        stableBottomRounds++;
      } else {
        stableBottomRounds = 0;
      }
      previousHeight = metrics.height;

      console.log(
        `📜 [${ACCOUNT_NAME}] 掃描進度：${Math.min(metrics.y + metrics.viewport, metrics.height)}/${metrics.height}，已點擊 ${claimed} 個`
      );

      // 到達頁尾後持續等待並複查，讓延遲載入的內容有時間出現。
      if (atBottom) {
        await page.waitForTimeout(1200);
        if (stableBottomRounds >= 4) {
          scanCompleted = true;
          break;
        }
      } else {
        await page.evaluate(() => {
          window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.7)));
        });
        scrollSteps++;
        await page.waitForTimeout(1000);
      }
    }

    console.log(`📜 [${ACCOUNT_NAME}] 滾動次數：${scrollSteps}`);
    console.log(`🔍 [${ACCOUNT_NAME}] 完整掃描：${scanCompleted ? '是' : '否'}；點擊失敗：${failedClicks}`);

    console.log(`✅ [${ACCOUNT_NAME}] 完成：${claimed}`);

    const isSuccess = scanCompleted && claimed > 0 && failedClicks === 0;
    const checkedAt = new Date().toISOString();

    state.lastClaimAt = checkedAt;
    state.lastResult = isSuccess ? "成功" : "失敗";

    state.success = isSuccess;
    state.fullScan = scanCompleted && failedClicks === 0;

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
