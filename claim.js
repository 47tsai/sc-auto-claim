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

    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2000);

    console.log(`👉 [${ACCOUNT_NAME}] 開始完整掃描頁面`);

    const MAX_SCAN_STEPS = 80;
    const MAX_RUNTIME_MS = 4 * 60 * 1000;
    const CLICK_TIMEOUT_MS = 4000;
    const MARKER = 'data-auto-claim-target';
    const interactiveSelector =
      'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"], [tabindex]:not([tabindex="-1"])';

    let failedClicks = 0;
    let scrollSteps = 0;
    let stableBottomRounds = 0;
    let previousHeight = 0;
    let scanCompleted = false;
    const scanStartedAt = Date.now();
    const attemptedKeys = new Set();

    const findCandidates = async (scanId) => page.evaluate(({ scanId, selector, marker }) => {
      document.querySelectorAll(`[${marker}]`).forEach((el) => el.removeAttribute(marker));

      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          style.pointerEvents !== 'none' && Number(style.opacity) !== 0 &&
          rect.width > 0 && rect.height > 0;
      };
      const labelOf = (el) => (
        el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') ||
        el.value || el.textContent || ''
      ).replace(/\s+/g, ' ').trim();
      const matches = (value) => {
        const text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!text || text.length > 100) return false;
        return /\b(claim|get|free|collect|redeem)\b/i.test(text) ||
          /領取|免費|领取|免费/.test(text);
      };

      const targets = new Set();
      for (const el of document.querySelectorAll(selector)) {
        if (visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
            matches(labelOf(el))) targets.add(el);
      }

      // Search leaf text once in the page context, not through hundreds of Playwright calls.
      for (const el of document.querySelectorAll('body *')) {
        if (el.children.length || !visible(el) || !matches(labelOf(el))) continue;
        const target = el.closest(selector) || el;
        if (visible(target) && !target.disabled &&
            target.getAttribute('aria-disabled') !== 'true') targets.add(target);
      }

      const result = [];
      let index = 0;
      for (const el of targets) {
        const label = labelOf(el);
        if (!matches(label)) continue;
        const context = el.closest('article, li, [role="listitem"], [data-testid]') ||
          el.parentElement?.parentElement || el.parentElement;
        const contextText = (context?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 180);
        const key = [label.toLowerCase(), el.getAttribute('aria-label') || '', contextText].join('|');
        const id = `${scanId}-${index++}`;
        el.setAttribute(marker, id);
        result.push({ id, label: label.slice(0, 100), key, tag: el.tagName.toLowerCase(), html: el.outerHTML.slice(0, 350) });
      }
      return result;
    }, { scanId, selector: interactiveSelector, marker: MARKER });

    for (let step = 0; step < MAX_SCAN_STEPS; step++) {
      if (Date.now() - scanStartedAt >= MAX_RUNTIME_MS) {
        console.log(`⏱️ [${ACCOUNT_NAME}] 已達 4 分鐘執行上限，停止掃描`);
        break;
      }

      const candidates = await findCandidates(`scan${step}`);
      let clickedThisRound = false;
      let checked = 0;

      for (const candidate of candidates) {
        if (Date.now() - scanStartedAt >= MAX_RUNTIME_MS || checked >= 40) break;
        if (attemptedKeys.has(candidate.key)) continue;
        attemptedKeys.add(candidate.key);
        checked++;

        console.log(`🔎 [${ACCOUNT_NAME}] 找到候選元素：${JSON.stringify(candidate.label)} <${candidate.tag}>`);
        const locator = page.locator(`[${MARKER}="${candidate.id}"]`).first();

        try {
          await locator.click({ timeout: CLICK_TIMEOUT_MS, noWaitAfter: true });
          claimed++;
          clickedThisRound = true;
          console.log(`🟢 [${ACCOUNT_NAME}] 已送出點擊：${JSON.stringify(candidate.label)}（累計 ${claimed}）`);
          await page.waitForTimeout(800);
          break;
        } catch (err) {
          let fallbackClicked = false;
          try {
            fallbackClicked = await page.evaluate(({ id, marker }) => {
              const el = document.querySelector(`[${marker}="${id}"]`);
              if (!el || !el.isConnected || el.disabled ||
                  el.getAttribute('aria-disabled') === 'true') return false;
              const style = getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              if (style.display === 'none' || style.visibility === 'hidden' ||
                  rect.width <= 0 || rect.height <= 0) return false;
              el.click();
              return true;
            }, { id: candidate.id, marker: MARKER });
          } catch {}

          if (fallbackClicked) {
            claimed++;
            clickedThisRound = true;
            console.log(`🟡 [${ACCOUNT_NAME}] DOM 備援已送出點擊：${JSON.stringify(candidate.label)}（累計 ${claimed}）`);
            await page.waitForTimeout(800);
            break;
          }

          failedClicks++;
          console.log(`⚠️ [${ACCOUNT_NAME}] 點擊失敗：${JSON.stringify(candidate.label)}；${err.message.split('\n')[0]}`);
          console.log(`   元素資訊：${candidate.html}`);
        }
      }

      // Re-query after a click because the store may rerender or remove the claimed item.
      if (clickedThisRound) continue;

      const metrics = await page.evaluate(() => ({
        y: window.scrollY,
        viewport: window.innerHeight,
        height: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0)
      }));
      const atBottom = metrics.y + metrics.viewport >= metrics.height - 8;
      stableBottomRounds = atBottom && metrics.height === previousHeight ? stableBottomRounds + 1 : 0;
      previousHeight = metrics.height;

      console.log(`📜 [${ACCOUNT_NAME}] 掃描進度：${Math.min(metrics.y + metrics.viewport, metrics.height)}/${metrics.height}，已點擊 ${claimed} 個`);

      if (atBottom) {
        await page.waitForTimeout(700);
        if (stableBottomRounds >= 3) {
          scanCompleted = true;
          break;
        }
      } else {
        await page.evaluate(() => window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.75))));
        scrollSteps++;
        await page.waitForTimeout(600);
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
