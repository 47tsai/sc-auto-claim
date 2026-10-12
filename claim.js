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

  if (state.success === true && (state.logicVersion === 2 || state.fullScan === true)) {
    console.log(`😴 [${ACCOUNT_NAME}] 今日已完成完整掃描並成功，跳過`);
    return;
  }

  // 舊版只要點到一個按鈕就會記為成功，不能讓這種紀錄阻止新版補領。
  if (state.success === true && state.fullScan !== true) {
    console.log(`🔁 [${ACCOUNT_NAME}] 發現舊版成功紀錄，重新完整掃描以補領剩餘內容`);
    state.success = false;
    state.logicVersion = 2;
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
    let completedRounds = 0;
    let scanCompleted = false;
    let fatalPageError = null;
    const scanStartedAt = Date.now();
    const successfulKeys = new Set();
    const roundFailedKeys = new Set();

    const findCandidates = async (scanId) => page.evaluate(({ scanId, selector, marker }) => {
      document.querySelectorAll("[" + marker + "]").forEach((el) => el.removeAttribute(marker));

      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" &&
          style.pointerEvents !== "none" && Number(style.opacity) !== 0 &&
          rect.width > 0 && rect.height > 0;
      };
      const labelOf = (el) => (
        el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") ||
        el.value || el.textContent || ""
      ).replace(/\s+/g, " ").trim();
      const hasClaimIntent = (value) => {
        const text = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!text || text.length > 100) return false;
        // Navigation wording is not a claim action unless the label explicitly says to claim/redeem.
        const explicitClaim = /\b(claim|get reward|collect|redeem|领取|領取)\b/i.test(text) ||
          /领取|領取/.test(text);
        if (!explicitClaim && /(前往|前去|跳至|跳到|查看|了解更多|go to|visit|jump to|learn more|more info)/i.test(text)) {
          return false;
        }
        if (!/\b(claim|get|free|collect|redeem)\b/i.test(text) && !/領取|免費|领取|免费/.test(text)) {
          return false;
        }
        return true;
      };

      const targets = new Set();
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") continue;
        const label = labelOf(el);
        if (!hasClaimIntent(label)) continue;

        // A free-only same-page anchor is likely navigation, not a reward action.
        const href = el.getAttribute("href") || "";
        const freeOnly = /^(free|免費|免费)$/i.test(label);
        if (freeOnly && el.tagName === "A" && href.startsWith("#")) continue;
        targets.add(el);
      }

      // Include text-bearing elements only when they resolve to an interactive ancestor.
      for (const el of document.querySelectorAll("body *")) {
        if (el.children.length || !visible(el) || !hasClaimIntent(labelOf(el))) continue;
        const target = el.closest(selector);
        if (!target || !visible(target) || target.disabled ||
            target.getAttribute("aria-disabled") === "true") continue;
        const targetLabel = labelOf(target);
        if (hasClaimIntent(targetLabel)) targets.add(target);
      }

      const result = [];
      let index = 0;
      for (const el of targets) {
        const label = labelOf(el);
        if (!hasClaimIntent(label)) continue;
        const context = el.closest('article, li, [role="listitem"], [data-testid]') ||
          el.parentElement?.parentElement || el.parentElement;
        const contextText = (context?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 180);
        const href = el.getAttribute("href") || "";
        const aria = el.getAttribute("aria-label") || "";
        const testId = el.getAttribute("data-testid") || "";
        const key = [
          el.tagName.toLowerCase(),
          label.toLowerCase(),
          aria,
          href,
          testId,
          contextText
        ].join("|");
        const id = scanId + "-" + index++;
        el.setAttribute(marker, id);
        result.push({
          id,
          label: label.slice(0, 100),
          key,
          tag: el.tagName.toLowerCase(),
          html: el.outerHTML.slice(0, 350)
        });
      }
      return result;
    }, { scanId, selector: interactiveSelector, marker: MARKER });

    const reloadPage = async (reason) => {
      console.log("🔄 [" + ACCOUNT_NAME + "] 刷新頁面：" + reason);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.scrollTo(0, 0));
    };

    let shouldStop = false;

    // Round 1 is the normal full-page pass. Round 2 is the one and only recovery pass.
    // A successful click/reload/re-scan stays within the same round.
    for (let round = 1; round <= 2 && !shouldStop; round++) {
      completedRounds = round;
      roundFailedKeys.clear();
      scrollSteps = 0;
      let stableBottomRounds = 0;
      let previousHeight = 0;
      let anyCandidateThisRound = false;

      console.log("🔍 [" + ACCOUNT_NAME + "] 開始第 " + round + "/2 輪掃描");

      while (!shouldStop) {
        if (Date.now() - scanStartedAt >= MAX_RUNTIME_MS) {
          console.log("⏱️ [" + ACCOUNT_NAME + "] 已達 4 分鐘執行上限，停止掃描");
          shouldStop = true;
          break;
        }

        const candidates = await findCandidates("round" + round + "-scan" + scrollSteps);
        if (candidates.length) anyCandidateThisRound = true;

        let clickedSuccessfully = false;
        for (const candidate of candidates) {
          if (Date.now() - scanStartedAt >= MAX_RUNTIME_MS) {
            shouldStop = true;
            break;
          }
          if (successfulKeys.has(candidate.key) || roundFailedKeys.has(candidate.key)) continue;

          console.log("🔎 [" + ACCOUNT_NAME + "] 找到候選元素：" +
            JSON.stringify(candidate.label) + " <" + candidate.tag + ">");
          const locator = page.locator("[" + MARKER + "=\"" + candidate.id + "\"]").first();

          let clickError = null;
          try {
            await locator.click({ timeout: CLICK_TIMEOUT_MS, noWaitAfter: true });
          } catch (err) {
            clickError = err;
          }

          if (!clickError) {
            claimed++;
            clickedSuccessfully = true;
            successfulKeys.add(candidate.key);
            console.log("🟢 [" + ACCOUNT_NAME + "] 點擊操作成功：" +
              JSON.stringify(candidate.label) + "（累計 " + claimed + "）");
            try {
              await reloadPage("點擊操作成功後立即刷新");
            } catch (err) {
              fatalPageError = "點擊成功後刷新失敗：" + String(err.message || err);
              console.log("❌ [" + ACCOUNT_NAME + "] " + fatalPageError);
              shouldStop = true;
            }
            break;
          }

          let fallbackClicked = false;
          try {
            fallbackClicked = await page.evaluate(({ id, marker }) => {
              const el = document.querySelector("[" + marker + "=\"" + id + "\"]");
              if (!el || !el.isConnected || el.disabled ||
                  el.getAttribute("aria-disabled") === "true") return false;
              const style = getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              if (style.display === "none" || style.visibility === "hidden" ||
                  rect.width <= 0 || rect.height <= 0) return false;
              el.click();
              return true;
            }, { id: candidate.id, marker: MARKER });
          } catch {}

          if (fallbackClicked) {
            claimed++;
            clickedSuccessfully = true;
            successfulKeys.add(candidate.key);
            console.log("🟡 [" + ACCOUNT_NAME + "] DOM 備援點擊成功：" +
              JSON.stringify(candidate.label) + "（累計 " + claimed + "）");
            try {
              await reloadPage("DOM 備援點擊後立即刷新");
            } catch (err) {
              fatalPageError = "DOM 備援點擊後刷新失敗：" + String(err.message || err);
              console.log("❌ [" + ACCOUNT_NAME + "] " + fatalPageError);
              shouldStop = true;
            }
            break;
          }

          failedClicks++;
          roundFailedKeys.add(candidate.key);
          console.log("⚠️ [" + ACCOUNT_NAME + "] 點擊失敗，暫不刷新，繼續下一個候選項目：" +
            JSON.stringify(candidate.label) + "；" + String(clickError.message || clickError).split("\n")[0]);
          console.log("   元素資訊：" + candidate.html);
        }

        if (shouldStop) break;
        if (clickedSuccessfully) {
          // The page has been refreshed. Re-scan current DOM immediately; do not use stale elements.
          stableBottomRounds = 0;
          previousHeight = 0;
          continue;
        }

        const metrics = await page.evaluate(() => ({
          y: window.scrollY,
          viewport: window.innerHeight,
          height: Math.max(
            document.body?.scrollHeight || 0,
            document.documentElement?.scrollHeight || 0
          )
        }));
        const atBottom = metrics.y + metrics.viewport >= metrics.height - 8;
        stableBottomRounds = atBottom && metrics.height === previousHeight
          ? stableBottomRounds + 1
          : 0;
        previousHeight = metrics.height;

        console.log("📜 [" + ACCOUNT_NAME + "] 第 " + round + " 輪進度：" +
          Math.min(metrics.y + metrics.viewport, metrics.height) + "/" + metrics.height +
          "，成功點擊 " + claimed + " 個");

        if (atBottom) {
          await page.waitForTimeout(700);
          if (stableBottomRounds >= 3) break;
        } else {
          if (scrollSteps >= MAX_SCAN_STEPS) {
            console.log("⚠️ [" + ACCOUNT_NAME + "] 已達單輪捲動上限");
            break;
          }
          await page.evaluate(() =>
            window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.75)))
          );
          scrollSteps++;
          await page.waitForTimeout(600);
        }
      }

      console.log("📜 [" + ACCOUNT_NAME + "] 第 " + round + " 輪結束：捲動 " +
        scrollSteps + " 次，累計點擊成功 " + claimed + "，點擊失敗 " + failedClicks);

      if (shouldStop) break;

      // If round 1 found no candidates, or any click failed, refresh once and try one recovery pass.
      // If all found actions were clicked successfully, finish without an unnecessary extra pass.
      if (round === 1) {
        const needsRecovery = !anyCandidateThisRound || roundFailedKeys.size > 0;
        if (!needsRecovery) {
          scanCompleted = true;
          break;
        }
        try {
          await reloadPage("第一輪結束，準備唯一一次補救掃描");
        } catch (err) {
          fatalPageError = "補救刷新失敗：" + String(err.message || err);
          console.log("❌ [" + ACCOUNT_NAME + "] " + fatalPageError);
          shouldStop = true;
        }
      } else {
        scanCompleted = true;
      }
    }

    console.log("🔍 [" + ACCOUNT_NAME + "] 完成掃描輪數：" + completedRounds);
    console.log("🔍 [" + ACCOUNT_NAME + "] 完整掃描流程：" + (scanCompleted ? "是" : "否") +
      "；點擊失敗：" + failedClicks);
    console.log("✅ [" + ACCOUNT_NAME + "] 點擊操作成功數： " + claimed);

    if (fatalPageError) state.lastError = fatalPageError;
    else delete state.lastError;

    const isSuccess = claimed >= 1;
    state.lastClaimAt = new Date().toISOString();
    state.lastResult = isSuccess ? "成功" : "失敗";

    state.success = isSuccess;
    state.fullScan = scanCompleted;
    state.logicVersion = 2;

    saveState(state);
    console.log(`RESULT=${isSuccess ? "success" : "failure"}`);
    await notify(claimed, ACCOUNT_NAME, isSuccess);

  } catch (err) {
    console.log("❌ error", err);

    const isSuccess = claimed >= 1;
    state.lastClaimAt = new Date().toISOString();
    state.lastResult = isSuccess ? "成功" : "失敗";
    state.success = isSuccess;
    state.logicVersion = 2;
    state.lastError = String(err.message || err).slice(0, 500);
    saveState(state);

    console.log("RESULT=" + (isSuccess ? "success" : "failure"));
    await notify(claimed, ACCOUNT_NAME, isSuccess);
  } finally {
    await browser.close();
  }
})();
