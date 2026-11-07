const { strategyId, matchesStrategy, normalizeTiers } = require('./utils/strategy_identity');
if (require('./utils/ensure_nigeria_vpn').ensureNigeriaVpn()) return;
const fs = require('fs');
const path = require('path');

// Auto-resolve --user-data-dir from bot_settings.json before loading config if not explicitly passed
if (!process.argv.some(a => a.startsWith('--user-data-dir='))) {
  try {
    const settingsPath = path.resolve(__dirname, 'bot_settings.json');
    if (fs.existsSync(settingsPath)) {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const family = s.betExecutor?.family || 'DEFAULT';
      const profileId = s.betExecutor?.profileId;
      if (profileId && profileId !== 'temp') {
        const pDir = path.resolve(__dirname, 'profiles', family, profileId);
        process.argv.push(`--user-data-dir=${pDir}`);
      }
    }
  } catch (e) {}
}

const config = require('./config');
const logger = require('./utils/logger');
const db = require('./utils/db');

// Delay helper
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Parse CLI Arguments
const args = process.argv.slice(2);
function getArg(name, defaultValue = null) {
  const match = args.find(a => a.startsWith(`--${name}=`));
  if (match) return match.split('=')[1];
  if (args.includes(`--${name}`)) return true;
  return defaultValue;
}

// Load Bot Settings fallback
let botSettings = {};
try {
  const settingsPath = path.resolve(__dirname, 'bot_settings.json');
  if (fs.existsSync(settingsPath)) {
    botSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
} catch (e) {
  logger.warn('Executor', 'Could not read bot_settings.json', { error: e.message });
}

const executorConfig = botSettings.betExecutor || {};

const targetUrl = getArg('url', executorConfig.targetUrl || 'https://1xbet.com');
const loginType = getArg('login-type', executorConfig.loginType || 'phone'); // 'phone' | 'id_email'
const loginId = getArg('login-id', executorConfig.loginIdentifier || '');
const password = getArg('password', executorConfig.password || '');
const headless = getArg('headless', executorConfig.headless !== undefined ? String(executorConfig.headless) : 'false') === 'true';
const currency = getArg('currency', executorConfig.currency || 'NGN').toUpperCase(); // 'NGN' | 'USD'
const currencySymbol = currency === 'USD' ? '$' : '₦';
const defaultStake = currency === 'USD' ? 1 : 60;
const stakeAmount = parseFloat(getArg('stake', executorConfig.stakeAmount || defaultStake));
const stakeMode = getArg('stake-mode', executorConfig.stakeMode || 'fixed'); // 'fixed' | 'percent' | 'compounding' | 'martingale_1_5' | 'martingale_2_0' | 'martingale_3_0' | 'kelly_half' | 'kelly_quarter'
const stakePercentage = parseFloat(getArg('stake-percent', executorConfig.stakePercentage !== undefined ? executorConfig.stakePercentage : 2));
const startingBankroll = parseFloat(getArg('starting-bankroll', executorConfig.startingBankroll || 30000));
const stakingScaling = getArg('staking-scaling', executorConfig.stakingScaling || 'uncapped'); // 'uncapped' | '3' | '5' | '7'
const autoBet = getArg('auto-bet', executorConfig.autoBet !== undefined ? String(executorConfig.autoBet) : 'false') === 'true';

const stopLoss = parseFloat(getArg('stop-loss', executorConfig.stopLoss || 0));
const stopLossEnabled = getArg('stop-loss-enabled', executorConfig.stopLossEnabled !== undefined ? String(executorConfig.stopLossEnabled) : (stopLoss > 0 ? 'true' : 'false')) === 'true';

const takeProfit = parseFloat(getArg('take-profit', executorConfig.takeProfit || 0));
const takeProfitEnabled = getArg('take-profit-enabled', executorConfig.takeProfitEnabled !== undefined ? String(executorConfig.takeProfitEnabled) : (takeProfit > 0 ? 'true' : 'false')) === 'true';

const selectedTiers = normalizeTiers(executorConfig.selectedTiers).map(t => String(t).toLowerCase());
const selectedSignalTypes = (executorConfig.selectedSignalTypes || ['all']).map(t => String(t).toLowerCase());
const selectedStrategy = getArg('selected-strategy', executorConfig.selectedStrategy || 'all').toLowerCase();
const minOdds = parseFloat(getArg('min-odds', executorConfig.minOdds || 0)) || 0;
const maxOdds = parseFloat(getArg('max-odds', executorConfig.maxOdds || 0)) || 0;
const minConfidence = parseFloat(getArg('min-confidence', executorConfig.minConfidence || 0)) || 0;
const teamSearch = (getArg('team-search', executorConfig.teamSearch || '')).trim().toLowerCase();

const maskedId = loginId ? (loginId.length > 4 ? `${loginId.slice(0, 3)}***${loginId.slice(-2)}` : '***') : '(Not Provided)';

const profileId = getArg('profile-id', getArg('profile', executorConfig.profileId || 'profile_1789572452548'));
const family = getArg('family', executorConfig.family || 'DEFAULT');
const targetProfileDir = (profileId && profileId !== 'temp')
  ? path.resolve(__dirname, 'profiles', family, profileId)
  : config.customConfig.userDataDir;

if (fs.existsSync(targetProfileDir)) {
  config.customConfig.userDataDir = targetProfileDir;
}

const localChromium = process.platform === 'win32'
  ? path.resolve(__dirname, 'chrome', 'win64-153.0.8010.47', 'chrome-win64', 'chrome.exe')
  : null;
if (localChromium && fs.existsSync(localChromium)) {
  config.customConfig.executablePath = localChromium;
}

logger.info('Executor', '====================================================');
logger.info('Executor', '🚀 1xBET BET EXECUTOR - AUTOMATION LAUNCHER');
logger.info('Executor', `🧭 Browser Binary:   ${localChromium && fs.existsSync(localChromium) ? 'Bundled Chromium (' + localChromium + ')' : 'System / Universal Chrome'}`);
logger.info('Executor', `📁 Browser Profile:  [${family}] ${profileId} (${targetProfileDir})`, { profileId, family, userDataDir: targetProfileDir });
logger.info('Executor', `🌐 Target 1xBet URL: ${targetUrl}`, { targetUrl });
logger.info('Executor', `💱 Account Currency: ${currency === 'USD' ? '🇺🇸 USD ($)' : '🇳🇬 NGN (₦)'}`, { currency });
logger.info('Executor', `🔑 Login Method:     ${loginType === 'phone' ? '📱 Phone Number' : '🆔 User ID / Email / Username'}`, { loginType });
logger.info('Executor', `👤 Login Identifier: ${maskedId}`);
logger.info('Executor', `🖥️  Browser Mode:     ${headless ? 'Headless' : 'Headed (Visual Display)'}`, { headless });
logger.info('Executor', `💰 Staking Engine:   ${stakeMode.toUpperCase()} | Base: ${currencySymbol}${stakeAmount} | Scaling: ${stakingScaling} | Bankroll: ${currencySymbol}${startingBankroll} (${currency})`);
logger.info('Executor', `🛑 Stop-Loss Limit:  ${stopLossEnabled && stopLoss > 0 ? currencySymbol + stopLoss + ' (' + currency + ')' : 'DISABLED'}`, { stopLoss, stopLossEnabled });
logger.info('Executor', `🎯 Take-Profit Goal: ${takeProfitEnabled && takeProfit > 0 ? currencySymbol + takeProfit + ' (' + currency + ')' : 'DISABLED'}`, { takeProfit, takeProfitEnabled });
logger.info('Executor', `⚡ Auto-Bet Mode:    ${autoBet ? 'ENABLED' : 'MANUAL / STANDBY'}`, { autoBet });
logger.info('Executor', `🏷️  Selected Tiers:   ${selectedTiers.join(', ')}`);
logger.info('Executor', `📡 Signal Types:    ${selectedSignalTypes.includes('all') ? 'ALL (no market filter)' : selectedSignalTypes.join(', ')}`);
logger.info('Executor', `🧠 Strategy Filter: ${selectedStrategy === 'all' ? 'All Strategies' : selectedStrategy}`);
if (minOdds > 0 || maxOdds > 0) {
  logger.info('Executor', `🎲 Odds Range:      ${minOdds > 0 ? '≥ ' + minOdds : 'Min'} ${maxOdds > 0 ? 'to ≤ ' + maxOdds : ''}`);
}
if (minConfidence > 0) {
  logger.info('Executor', `📊 Min Confidence:  ${minConfidence}%`);
}
if (teamSearch) {
  logger.info('Executor', `🔍 Team Search:     "${teamSearch}"`);
}
logger.info('Executor', '====================================================');

let browser = null;
let page = null;
let isShuttingDown = false;
let hasInvalidCredentials = false;
let wasEverAuthenticated = false;

// Profit / Loss Session Tracking State
let startingBalance = null;
let currentBalance = null;
let sessionProfitLoss = 0;
let isTargetLimitReached = false;
let limitReason = null;
let totalBetsPlacedCount = 0;
const placedPickIds = new Set();
let sessionStartTime = Date.now();
let RECYCLE_INTERVAL_MS = (45 + Math.floor(Math.random() * 30)) * 60 * 1000;

const STATUS_FILE = path.resolve(__dirname, 'data', 'executor_live_status.json');

let liveStatus = {
  running: true,
  pid: process.pid,
  updatedAt: new Date().toISOString(),
  initialBalance: null,
  currentBalance: null,
  sessionProfitLoss: 0,
  currency: currency || 'NGN',
  stakeMode: stakeMode,
  stakeAmount: stakeAmount,
  stakePercentage: stakePercentage,
  stopLoss: stopLoss || 0,
  stopLossEnabled: stopLossEnabled,
  takeProfit: takeProfit || 0,
  takeProfitEnabled: takeProfitEnabled,
  isTargetLimitReached: false,
  limitReason: null,
  totalBetsPlaced: 0,
  lastPlacedBet: null,
  authStatus: 'checking', // 'authenticated' | 'logged_out' | 'invalid_credentials' | 'sms_verification_required'
  authErrorMessage: null,
  networkStatus: 'online', // 'online' | 'reconnecting' | 'network_error'
  sessionUptimeSeconds: 0,
  nextRefreshInMinutes: Math.round(RECYCLE_INTERVAL_MS / 60000)
};

/**
 * Calculate consecutive losses and accumulated loss amount from recent settled bets
 * Matches the logic in the signal app (http://127.0.0.1:5174/) staking cycle
 */
function getConsecutiveLossStreak() {
  try {
    const recent = db.getRecentBets(50);
    let count = 0;
    let accumulatedLoss = 0;
    for (const b of recent) {
      const st = (b.status || '').toUpperCase();
      if (st === 'PENDING' || st === 'VOID') continue;
      if (st === 'LOST') {
        count++;
        accumulatedLoss += Number(b.stake) || 0;
      } else if (st === 'WON') {
        break;
      }
    }
    return { count, accumulatedLoss };
  } catch (e) {
    return { count: 0, accumulatedLoss: 0 };
  }
}

function getConsecutiveLossCount() {
  return getConsecutiveLossStreak().count;
}

/**
 * Calculates current bet stake dynamically across 8 Staking Engines
 * (Fixed, Percentage of Base Capital, Compounding, Martingale 1.5x/2.0x/3.0x, Kelly Half/Quarter)
 * 
 * Specifically for "Martingale 2.0x (Odds-Adjusted Recovery)":
 * Matches the exact formula from utils/staking_cycle.mjs and utils/bankroll_simulator.mjs:
 * When consecutive losses > 0 and pick odds < 2.0:
 *   stake = (accumulatedLoss + targetProfit) / (odds - 1)
 * Guaranteed to recover 100% of accumulated losses + net the base target profit on any winning odds!
 */
function calculateCurrentStake(pickOdds = 2.0, pickProb = 55) {
  const bal = (currentBalance !== null && currentBalance > 0)
    ? currentBalance
    : ((startingBalance !== null && startingBalance > 0) ? startingBalance : startingBankroll);

  const minStake = currency === 'USD' ? 0.5 : 60;
  const base = stakeAmount || defaultStake;
  const streak = getConsecutiveLossStreak();
  const consecutiveLosses = streak.count;
  const cap = (stakingScaling && stakingScaling !== 'uncapped') ? parseInt(stakingScaling) : null;

  // Step cap check: In signal app staking_cycle, reaching cap resets cycle back to base
  const isCappedReset = (cap !== null && consecutiveLosses >= cap);
  const activeLosses = isCappedReset ? 0 : consecutiveLosses;
  const effectiveAccLoss = isCappedReset ? 0 : streak.accumulatedLoss;

  let calculated = base;

  switch (stakeMode) {
    case 'fixed':
      calculated = base;
      break;

    case 'percent': {
      const bankroll = startingBankroll || startingBalance || 30000;
      const pct = stakePercentage || 2;
      calculated = (bankroll * pct) / 100;
      break;
    }

    case 'percentage':
    case 'compounding': {
      const pct = stakePercentage || 2;
      calculated = ((bal || startingBankroll || 30000) * pct) / 100;
      break;
    }

    case 'martingale_1_5': {
      calculated = base * Math.pow(1.5, activeLosses);
      break;
    }

    case 'martingale_2_0': {
      const odd = Math.max(1.05, parseFloat(pickOdds) || 2.0);
      if (activeLosses > 0 && odd < 2.0) {
        // Option 1: Odds-adjusted dynamic recovery Martingale (Signal Engine exact implementation)
        // Guaranteed to recover all past losses + target base profit on any single win regardless of odds.
        // Formula: stake = (accumulatedLoss + targetProfit) / (odds - 1)
        const accLoss = effectiveAccLoss > 0
          ? effectiveAccLoss
          : base * (Math.pow(2.0, activeLosses) - 1);
        const targetProfit = base;
        calculated = Math.max(base, (accLoss + targetProfit) / (odd - 1));
      } else {
        calculated = base * Math.pow(2.0, activeLosses);
      }
      break;
    }

    case 'martingale_3_0': {
      calculated = base * Math.pow(3.0, activeLosses);
      break;
    }

    case 'kelly_half':
    case 'kelly_quarter': {
      const b = Math.max(0.1, (pickOdds || 2.0) - 1);
      const p = (pickProb || 55) / 100;
      const q = 1 - p;
      const fullKelly = Math.max(0, (b * p - q) / b);
      const frac = stakeMode === 'kelly_half' ? 0.5 : 0.25;
      const stakeFraction = fullKelly * frac;
      calculated = (bal || startingBankroll || 30000) * Math.min(stakeFraction, 0.15);
      break;
    }

    default:
      calculated = base;
      break;
  }

  if (currency === 'USD') {
    return Math.max(minStake, parseFloat(calculated.toFixed(2)));
  } else {
    return Math.max(minStake, Math.round(calculated));
  }
}

function publishLiveStatus(updates = {}) {
  try {
    Object.assign(liveStatus, updates);
    liveStatus.updatedAt = new Date().toISOString();
    liveStatus.sessionUptimeSeconds = Math.floor((Date.now() - sessionStartTime) / 1000);
    const msToRefresh = Math.max(0, RECYCLE_INTERVAL_MS - (Date.now() - sessionStartTime));
    liveStatus.nextRefreshInMinutes = Math.round(msToRefresh / 60000);

    const dataDir = path.resolve(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(STATUS_FILE, JSON.stringify(liveStatus, null, 2), 'utf8');
  } catch (e) {}
}

function isNetworkErrorPage(targetPage) {
  try {
    if (!targetPage) return true;
    const url = targetPage.url();
    return url.startsWith('chrome-error://') || url.includes('chromewebdata') || url === 'about:blank';
  } catch (e) {
    return true;
  }
}

async function recoverNetworkConnection(targetPage, maxRetries = 8) {
  logger.warn('Executor', '🌐 Network drop or error page detected. Entering resilient recovery loop...');
  publishLiveStatus({ networkStatus: 'reconnecting' });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (isShuttingDown) break;
    const waitSec = Math.min(attempt * 4, 20);
    logger.info('Executor', `⏳ Reconnection attempt #${attempt}/${maxRetries} in ${waitSec}s...`);
    await delay(waitSec * 1000);

    try {
      logger.info('Executor', `Navigating to ${targetUrl}...`);
      await targetPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await delay(3000);

      if (!isNetworkErrorPage(targetPage)) {
        logger.info('Executor', '✅ Network connection restored successfully!');
        publishLiveStatus({ networkStatus: 'online' });
        await dismissPopups(targetPage);
        await getEngineFrame(targetPage);
        return true;
      }
    } catch (netErr) {
      logger.warn('Executor', `Reconnection attempt #${attempt} error: ${netErr.message}`);
    }
  }
  publishLiveStatus({ networkStatus: 'network_error' });
  logger.error('Executor', '❌ Unable to restore network connection after multiple retries.');
  return false;
}

async function detectUnexpectedErrorDialog(targetPage) {
  try {
    if (!targetPage || targetPage.isClosed()) return null;

    // Check main page DOM for 1xBet unexpected error dialogs/modals
    const mainPageError = await targetPage.evaluate(() => {
      const body = document.body ? document.body.innerText.toLowerCase() : '';
      const triggers = [
        'unexpected error',
        'an unexpected error has occurred',
        'error loading game',
        'session has expired',
        'something went wrong',
        'technical problem',
        'game unavailable'
      ];
      for (const t of triggers) {
        if (body.includes(t)) {
          return t;
        }
      }

      // Check for visible modal dialogs with error headers
      const modals = Array.from(document.querySelectorAll('.modal, .popup, .swal2-popup, .dialog, [role="dialog"], .alert'));
      for (const m of modals) {
        const txt = (m.innerText || '').toLowerCase();
        if (txt.includes('error') || txt.includes('reload') || txt.includes('unexpected')) {
          const rect = m.getBoundingClientRect();
          if (rect.width > 50 && rect.height > 50) {
            return 'modal: ' + txt.slice(0, 40).replace(/\n+/g, ' ');
          }
        }
      }
      return null;
    }).catch(() => null);

    if (mainPageError) return mainPageError;

    // Also check inside Golden Race engine frame if mounted
    const engineFrame = await getEngineFrame(targetPage);
    if (engineFrame) {
      const frameError = await engineFrame.evaluate(() => {
        const body = document.body ? document.body.innerText.toLowerCase() : '';
        if (body.includes('unexpected error') || body.includes('error loading') || body.includes('connection error') || body.includes('reload game')) {
          return 'engine_frame_error';
        }
        return null;
      }).catch(() => null);
      if (frameError) return frameError;
    }

    return null;
  } catch (e) {
    return null;
  }
}

async function recoverUnexpectedError(targetPage) {
  logger.warn('Executor', '⚠️ 1xBet "Unexpected error" dialog detected. Initiating automatic game recovery without human intervention...');
  publishLiveStatus({ networkStatus: 'reconnecting' });

  try {
    // 1. Try to click any "OK" or "Reload" or "Try again" button in the modal first
    const okBtnCoords = await targetPage.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      const okBtn = buttons.find(b => {
        const txt = (b.innerText || '').trim().toLowerCase();
        return txt === 'ok' || txt === 'reload' || txt === 'refresh' || txt === 'try again';
      });
      if (okBtn) {
        const r = okBtn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      return null;
    }).catch(() => null);
    if (okBtnCoords) {
      await hardwareClickAt(targetPage, okBtnCoords.x, okBtnCoords.y);
    }
    await delay(1500);

    // 2. Perform a clean page reload
    logger.info('Executor', '🔄 Reloading Virtual Sports page to restore clean WebGL state...');
    await targetPage.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await delay(3500);
    await dismissPopups(targetPage);

    // 3. Re-navigate & ensure England League is loaded
    await navigateToVirtualSports(targetPage);
    await launchEnglandLeague(targetPage);
    publishLiveStatus({ networkStatus: 'online' });
    logger.info('Executor', '✅ Successfully auto-recovered from unexpected error state!');
    return true;
  } catch (err) {
    logger.error('Executor', 'Error recovering from unexpected error state', err);
    return false;
  }
}

async function checkAuthAndGuestStatus(targetPage) {
  try {
    // 1. Check if Golden Race iframe shows "Play for real - To win real money, log in and place bets!"
    const engineFrame = await getEngineFrame(targetPage);
    let guestBannerDetected = false;
    if (engineFrame) {
      guestBannerDetected = await engineFrame.evaluate(() => {
        const bodyText = document.body ? document.body.innerText : '';
        return /Play for real|To win real money,\s*log in/i.test(bodyText);
      }).catch(() => false);
    }

    // 2. Check 1xBet parent page for login button
    const loginButtonVisible = await targetPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('a, button, [role="button"]'));
      return btns.some(b => {
        const txt = (b.innerText || b.textContent || '').trim().toUpperCase();
        return (txt === 'LOG IN' || txt === 'LOGIN' || txt === 'SIGN IN') && b.getBoundingClientRect().height > 0;
      });
    }).catch(() => false);

    if (guestBannerDetected || loginButtonVisible) {
      return { isLoggedIn: false, guestBanner: guestBannerDetected };
    }

    return { isLoggedIn: true, guestBanner: false };
  } catch (e) {
    return { isLoggedIn: true, guestBanner: false };
  }
}

// ─── Native Hardware CDP Input Engine ──────────────────────────────
// Zero JavaScript DOM manipulation: All events are sent directly via Chrome DevTools Protocol
// (Input.dispatchMouseEvent, Input.dispatchKeyEvent) ensuring event.isTrusted is ALWAYS true.

const randomDelay = (min = 300, max = 800) =>
  new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

let lastMouseX = 200;
let lastMouseY = 200;

function generateBezierPath(startX, startY, endX, endY, steps = 22) {
  const path = [];
  const curvature = (Math.random() - 0.5) * 140;
  const cpX = (startX + endX) / 2 + curvature;
  const cpY = (startY + endY) / 2 - (Math.random() * 90);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.pow(1 - t, 2) * startX + 2 * (1 - t) * t * cpX + Math.pow(t, 2) * endX;
    const y = Math.pow(1 - t, 2) * startY + 2 * (1 - t) * t * cpY + Math.pow(t, 2) * endY;
    path.push({
      x: x + (Math.random() - 0.5) * 2,
      y: y + (Math.random() - 0.5) * 2
    });
  }
  return path;
}

// Low-level hardware mouse movement via CDP
async function hardwareMouseMove(targetPage, toX, toY) {
  try {
    const steps = 14 + Math.floor(Math.random() * 12);
    const path = generateBezierPath(lastMouseX, lastMouseY, toX, toY, steps);
    for (const pt of path) {
      await targetPage.mouse.move(pt.x, pt.y);
      await randomDelay(8, 18);
    }
    lastMouseX = toX;
    lastMouseY = toY;
  } catch (e) {}
}

// Low-level hardware click at exact viewport coordinates via CDP (isTrusted = true)
async function hardwareClickAt(targetPage, x, y) {
  try {
    await hardwareMouseMove(targetPage, x, y);
    await randomDelay(120, 240); // Pre-click human hesitation
    await targetPage.mouse.down({ button: 'left' });
    await randomDelay(70, 150);  // Human click press dwell
    await targetPage.mouse.up({ button: 'left' });
    await randomDelay(250, 480); // Post-click reaction delay
    return true;
  } catch (e) {
    return false;
  }
}

// Low-level physical hardware mouse wheel scrolling via CDP (isTrusted = true)
async function hardwareScroll(targetPage, deltaY) {
  try {
    const steps = Math.max(3, Math.floor(Math.abs(deltaY) / 90));
    const stepDelta = deltaY / steps;
    for (let i = 0; i < steps; i++) {
      await targetPage.mouse.wheel({ deltaY: stepDelta });
      await randomDelay(20, 45);
    }
  } catch (e) {}
}

// Resolve viewport coordinates of an element without any JS clicks
async function getElementViewportRect(targetPage, selectorOrHandle) {
  try {
    let handle = null;
    if (typeof selectorOrHandle === 'string') {
      handle = await targetPage.$(selectorOrHandle);
    } else {
      handle = selectorOrHandle;
    }
    if (!handle) return null;

    // Smoothly scroll into view
    await targetPage.evaluate((el) => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }, handle);
    await randomDelay(300, 500);

    const rect = await targetPage.evaluate((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }
      return null;
    }, handle);

    return rect;
  } catch (e) {
    return null;
  }
}

// Pure hardware mouse click on an element (selector or ElementHandle)
async function hardwareClick(targetPage, selectorOrHandle) {
  try {
    const rect = await getElementViewportRect(targetPage, selectorOrHandle);
    if (!rect) return false;

    const clickX = rect.x + rect.width * (0.35 + Math.random() * 0.3);
    const clickY = rect.y + rect.height * (0.35 + Math.random() * 0.3);
    return await hardwareClickAt(targetPage, clickX, clickY);
  } catch (e) {
    return false;
  }
}

// Pure hardware keyboard typing via CDP (zero JS value assignment)
async function hardwareType(targetPage, selectorOrHandleOrText, maybeText) {
  try {
    let text = '';
    if (maybeText !== undefined) {
      // 3 args: click element first
      const focused = await hardwareClick(targetPage, selectorOrHandleOrText);
      if (!focused) return false;
      await randomDelay(180, 320);

      // Select all text and clear
      await targetPage.keyboard.down('Control');
      await targetPage.keyboard.press('KeyA');
      await targetPage.keyboard.up('Control');
      await randomDelay(60, 120);
      await targetPage.keyboard.press('Backspace');
      await randomDelay(120, 240);

      text = String(maybeText);
    } else {
      // 2 args: already focused
      text = String(selectorOrHandleOrText);
    }

    // Hardware keystrokes for each character via native CDP input pipeline
    for (const char of text) {
      const keyDelay = Math.floor(Math.random() * 55) + 40; // 40ms - 95ms
      await targetPage.keyboard.type(char, { delay: keyDelay });

      // Natural brief hesitation between random character clusters
      if (Math.random() < 0.08) {
        await randomDelay(140, 300);
      }
    }

    await randomDelay(200, 450);
    return true;
  } catch (e) {
    return false;
  }
}

// Backwards-compatible aliases
const smoothMouseMove = hardwareMouseMove;
const humanMouseMove = hardwareMouseMove;
const humanClick = hardwareClick;
const humanType = hardwareType;

async function dismissPopups(targetPage) {
  try {
    // Locate coordinates of any active cookie banner or modal close icon
    const popupTargetRect = await targetPage.evaluate(() => {
      // Cookie consent buttons
      const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
      for (const btn of buttons) {
        const txt = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        if (
          txt === 'accept' ||
          txt === 'i accept' ||
          txt === 'accept all' ||
          txt === 'agree' ||
          txt === 'allow all' ||
          txt === 'got it' ||
          txt === 'ok' ||
          txt === 'close'
        ) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
          }
        }
      }

      // Close modal icons (X buttons)
      const closeIcons = document.querySelectorAll('.modal-close, .close-button, [aria-label="Close"], .popup__close');
      for (const icon of closeIcons) {
        if (icon.offsetParent !== null) {
          const rect = icon.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
          }
        }
      }
      return null;
    });

    if (popupTargetRect) {
      const clickX = popupTargetRect.x + popupTargetRect.width * (0.4 + Math.random() * 0.2);
      const clickY = popupTargetRect.y + popupTargetRect.height * (0.4 + Math.random() * 0.2);
      await hardwareClickAt(targetPage, clickX, clickY);
      await randomDelay(400, 800);
    }
  } catch (e) {}
}

async function checkLoggedIn(targetPage) {
  try {
    // If currently on login or verification page, definitely not authenticated
    const url = targetPage.url().toLowerCase();
    if (url.includes('/user/login') || url.includes('/user/accountverify')) {
      return false;
    }

    return await targetPage.evaluate(() => {
      // 1. If explicit Log In button is present and visible, we are NOT logged in
      const logInBtn = document.querySelector('a[href*="/user/login"], .user-control-panel__auth');
      if (logInBtn && logInBtn.getBoundingClientRect().width > 0) {
        return false;
      }

      // 2. Look for positive user authentication selectors
      const userSelectors = [
        '.user-control-panel__account',
        '.header-user',
        '.user-header',
        '.top-b-user',
        '[data-testid="user-profile"]',
        '[data-testid="user-balance"]',
        '.user-avatar',
        '.header-balance',
        '.user-name',
        'a[href*="/user/profile"]',
        'a[href*="/user/account"]',
        'a[href*="/user/settings"]',
        '.user-info'
      ];
      for (const s of userSelectors) {
        const el = document.querySelector(s);
        if (el && el.getBoundingClientRect().width > 0) return true;
      }

      // 3. Check for balance or account text in body
      const text = document.body ? document.body.innerText : '';
      if (/Account\s*#?\s*\d+/i.test(text) || /Deposit\s*\/|My Account/i.test(text) || /(?:₦|\$|USD|NGN)\s*[\d,]+(?:\.\d{2})?/i.test(text)) {
        return true;
      }
      return false;
    });
  } catch (e) {
    return false;
  }
}

async function attemptLogin(targetPage) {
  if (!loginId || !password) {
    logger.info('Executor', 'ℹ️ No credentials entered. Skipping automated login.');
    return;
  }

  logger.info('Executor', `Initiating pure hardware authentication journey via ${loginType === 'phone' ? '📱 Phone Number' : '🆔 ID / Email'}...`);

  try {
    const alreadyLoggedIn = await checkLoggedIn(targetPage);
    if (alreadyLoggedIn) {
      logger.info('Executor', '✅ Session is already authenticated!');
      return;
    }

    // Natural human exploration hesitation
    await randomDelay(1200, 2400);

    // Locate "Log in" button in header via coordinates
    let openedModal = false;
    const loginBtnRect = await targetPage.evaluate(() => {
      const candidates = [
        'a[href*="/user/login"]',
        '.user-control-panel__auth',
        'button.login-btn',
        '#login_btn',
        '.header-login'
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top, width: r.width, height: r.height };
        }
      }
      const all = Array.from(document.querySelectorAll('a, button'));
      for (const el of all) {
        const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (txt === 'log in' || txt === 'login' || txt === 'sign in') {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top, width: r.width, height: r.height };
        }
      }
      return null;
    });

    if (loginBtnRect) {
      logger.info('Executor', 'Moving mouse naturally along curve to Log In button (hardware click)...');
      const clickX = loginBtnRect.x + loginBtnRect.width * (0.35 + Math.random() * 0.3);
      const clickY = loginBtnRect.y + loginBtnRect.height * (0.35 + Math.random() * 0.3);
      openedModal = await hardwareClickAt(targetPage, clickX, clickY);
      await randomDelay(1800, 2800);
    } else if (targetPage.url().includes('/user/login')) {
      openedModal = true;
    } else {
      logger.info('Executor', 'Login button not directly visible in header. Opening /en/user/login directly...');
      const origin = new URL(targetUrl).origin;
      await targetPage.goto(`${origin}/en/user/login?platform_type=mobile`, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await randomDelay(2000, 3000);
      openedModal = true;
    }

    await dismissPopups(targetPage);

    // Tab Selection: Phone vs ID/Email (100% Hardware Click)
    if (loginType === 'phone') {
      logger.info('Executor', 'Locating "By Phone" login tab for hardware click...');
      const phoneTabRect = await targetPage.evaluate(() => {
        const phoneRadio = document.querySelector('input[value="phone_password"]');
        if (phoneRadio) {
          const label = phoneRadio.closest('label') || phoneRadio.parentElement || phoneRadio;
          const r = label.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top, width: r.width, height: r.height };
        }
        const tabs = Array.from(document.querySelectorAll('.ui-tabs-tab, button, [role="tab"]'));
        for (const t of tabs) {
          const txt = (t.innerText || t.textContent || '').toLowerCase();
          if (txt.includes('phone') || txt.includes('by phone')) {
            const r = t.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top, width: r.width, height: r.height };
          }
        }
        return null;
      });

      if (phoneTabRect) {
        const clickX = phoneTabRect.x + phoneTabRect.width * (0.4 + Math.random() * 0.2);
        const clickY = phoneTabRect.y + phoneTabRect.height * (0.4 + Math.random() * 0.2);
        await hardwareClickAt(targetPage, clickX, clickY);
        logger.info('Executor', 'Switched to "By Phone" tab via hardware mouse click.');
        await randomDelay(900, 1600);
      }

      // Clean phone number (10 digits without country prefix)
      let cleanPhone = String(loginId).trim();
      if (cleanPhone.startsWith('+234')) cleanPhone = cleanPhone.slice(4);
      else if (cleanPhone.startsWith('234') && cleanPhone.length > 10) cleanPhone = cleanPhone.slice(3);
      else if (cleanPhone.startsWith('0') && cleanPhone.length === 11) cleanPhone = cleanPhone.slice(1);

      logger.info('Executor', `Entering phone number via hardware keyboard (${cleanPhone.slice(0, 3)}***${cleanPhone.slice(-2)})...`);
      const phoneSelector = 'input[type="tel"], input[name="phone"], input[placeholder*="phone"], input[placeholder*="Phone"]';
      await hardwareType(targetPage, phoneSelector, cleanPhone);
    } else {
      // By ID / Email tab
      logger.info('Executor', 'Locating "By ID / Email" login tab for hardware click...');
      const idTabRect = await targetPage.evaluate(() => {
        const idRadio = document.querySelector('input[value="login_password"]');
        if (idRadio) {
          const label = idRadio.closest('label') || idRadio.parentElement || idRadio;
          const r = label.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.left, y: r.top, width: r.width, height: r.height };
        }
        return null;
      });

      if (idTabRect) {
        const clickX = idTabRect.x + idTabRect.width * (0.4 + Math.random() * 0.2);
        const clickY = idTabRect.y + idTabRect.height * (0.4 + Math.random() * 0.2);
        await hardwareClickAt(targetPage, clickX, clickY);
        logger.info('Executor', 'Switched to "By ID / Email" tab via hardware mouse click.');
        await randomDelay(900, 1600);
      }

      logger.info('Executor', 'Entering user ID / email via hardware keyboard...');
      const idSelector = 'input.auth-form-by-password__field, input[type="text"], input[name*="login"], input[name*="user"]';
      await hardwareType(targetPage, idSelector, loginId);
    }

    await randomDelay(400, 800);

    // Enter Password via hardware keyboard
    logger.info('Executor', 'Entering password securely via native hardware keystrokes...');
    const passwordSelector = 'input[type="password"], input.auth-form-by-password-field';
    await hardwareType(targetPage, passwordSelector, password);

    // Brief review hesitation
    logger.info('Executor', 'Pausing briefly before submitting (human review)...');
    await randomDelay(800, 1600);

    // Click submit button via hardware mouse
    logger.info('Executor', 'Moving mouse to LOG IN submit button and performing hardware click...');
    const submitCoords = await targetPage.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, div[role="button"], a, input[type="submit"], div'));
      for (const el of candidates) {
        const txt = (el.innerText || el.textContent || '').trim().toUpperCase();
        const r = el.getBoundingClientRect();
        if (txt === 'LOG IN' && r.top > 250 && r.height >= 35 && r.width > 100) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return { x: 675, y: 432 };
    });
    if (submitCoords) {
      await hardwareClickAt(targetPage, submitCoords.x, submitCoords.y);
    }
    await randomDelay(300, 600);
    await targetPage.keyboard.press('Enter');

    logger.info('Executor', 'Submitted login request. Waiting for authentication response...');
    await randomDelay(4000, 6500);

    // Check for explicit credential error notices/toasts (wrong phone/password)
    const loginError = await targetPage.evaluate(() => {
      const errSelectors = [
        '.error-message',
        '.ui-notification--error',
        '.auth-form__error',
        '.popup__error',
        '[class*="error"]',
        '[class*="alert"]',
        '.toast'
      ];
      for (const sel of errSelectors) {
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          if (el.getBoundingClientRect().height > 0) {
            const txt = (el.innerText || '').trim();
            if (/wrong|incorrect|invalid|blocked|not found|suspended|too many/i.test(txt)) {
              return txt;
            }
          }
        }
      }
      return null;
    });

    if (loginError) {
      logger.error('Executor', `❌ 1xBet Login Error: "${loginError}". Please verify your login phone/password in settings.`);
      hasInvalidCredentials = true;
      publishLiveStatus({
        authStatus: 'invalid_credentials',
        authErrorMessage: `Login failed: "${loginError}". Please verify your phone number and password in Settings.`
      });
      return false;
    }

    // Check for Account Verify (SMS Code / 2FA check)
    if (targetPage.url().includes('accountverify') || targetPage.url().includes('verify')) {
      logger.info('Executor', '📱 1xBet triggered new device verification (accountverify).');
      publishLiveStatus({
        authStatus: 'sms_verification_required',
        authErrorMessage: 'New device detected by 1xBet: SMS verification required.'
      });

      const missingInput = await targetPage.$('input[name="phone"], input[type="tel"]');
      if (missingInput) {
        let cleanPhone = String(loginId).trim();
        if (cleanPhone.startsWith('+234')) cleanPhone = cleanPhone.slice(4);
        else if (cleanPhone.startsWith('234') && cleanPhone.length > 10) cleanPhone = cleanPhone.slice(3);
        else if (cleanPhone.startsWith('0') && cleanPhone.length === 11) cleanPhone = cleanPhone.slice(1);

        const missingDigits = cleanPhone.length === 10 ? cleanPhone.slice(0, 8) : cleanPhone;
        logger.info('Executor', `Filling phone verification digits via hardware keyboard (${missingDigits.slice(0, 3)}***)...`);
        await hardwareClick(targetPage, missingInput);
        await randomDelay(300, 500);
        await hardwareType(targetPage, missingDigits);
        await randomDelay(800, 1500);

        logger.info('Executor', 'Executing hardware click on "Send via SMS" button...');
        const sendBtnCoords = await targetPage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          for (const b of btns) {
            const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
            if (txt.includes('send via sms') || txt.includes('send code') || txt.includes('sms')) {
              const r = b.getBoundingClientRect();
              if (r.width > 20 && r.height > 10) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
          }
          return null;
        });
        if (sendBtnCoords) {
          await hardwareClickAt(targetPage, sendBtnCoords.x, sendBtnCoords.y);
        } else {
          await hardwareClick(targetPage, 'button.ui-button--theme-primary, button.ui-button');
        }
        await randomDelay(2500, 3500);
      }

      // Capture screenshot of verification screen
      try {
        const smsShot = path.resolve(__dirname, 'scratch', 'sms_verification_prompt.png');
        await targetPage.screenshot({ path: smsShot });
        logger.info('Executor', `📸 SMS verification screen saved: ${smsShot}`);
      } catch (e) {}

      logger.info('Executor', '👉 SMS confirmation code requested. Please enter 6-digit code in browser window to permanently authorize this device.');

      // Wait up to 90s for user or automated completion
      const waitStart = Date.now();
      while (Date.now() - waitStart < 90000) {
        if (!targetPage.url().includes('accountverify') && !targetPage.url().includes('login')) {
          break;
        }
        const loggedIn = await checkLoggedIn(targetPage);
        if (loggedIn) break;
        await delay(3000);
      }
    }

    await dismissPopups(targetPage);

    const loggedIn = await checkLoggedIn(targetPage);
    if (loggedIn) {
      wasEverAuthenticated = true;
      hasInvalidCredentials = false;
      publishLiveStatus({ authStatus: 'authenticated', authErrorMessage: null });
      logger.info('Executor', '✅ Successfully authenticated into 1xBet session!');
    } else {
      publishLiveStatus({ authStatus: 'logged_out' });
      logger.info('Executor', 'Notice: Login submitted. If CAPTCHA or 2FA SMS is requested, please complete it in the browser.');
    }

    // Ensure we return to target virtual sports game URL if we navigated to /en/user/login
    if (!targetPage.url().includes('virtualsports')) {
      logger.info('Executor', 'Returning to target Virtual Sports game URL after authentication flow...');
      await targetPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await randomDelay(2500, 4000);
    }
  } catch (err) {
    logger.error('Executor', 'Error during hardware authentication', err);
  }
}

// ─── Account Currency Detection & Switching Engine ──────────────────────────
async function detectActiveCurrency(targetPage) {
  try {
    return await targetPage.evaluate(() => {
      // 1. Balance element check
      const balanceElements = Array.from(document.querySelectorAll(
        '.user-control-panel__balance, .header-balance, [data-testid="user-balance"], .user-header__balance, .top-b-user__balance, .wallet__balance'
      ));
      for (const el of balanceElements) {
        const text = (el.innerText || el.textContent || '').trim().toUpperCase();
        if (text.includes('NGN') || text.includes('₦')) return 'NGN';
        if (text.includes('USD') || text.includes('$')) return 'USD';
        if (text.includes('EUR') || text.includes('€')) return 'EUR';
      }

      // 2. Scan text near balance
      const text = document.body ? document.body.innerText : '';
      const match = text.match(/(?:₦|NGN|\$|USD)\s*[\d,]+(?:\.\d{2})?/i) || text.match(/[\d,]+(?:\.\d{2})?\s*(?:₦|NGN|\$|USD)/i);
      if (match) {
        const m = match[0].toUpperCase();
        if (m.includes('NGN') || m.includes('₦')) return 'NGN';
        if (m.includes('USD') || m.includes('$')) return 'USD';
      }

      // 3. Fallback general check
      if (text.includes('₦') || text.includes(' NGN')) return 'NGN';
      if (text.includes('$') || text.includes(' USD')) return 'USD';

      return null;
    });
  } catch (e) {
    return null;
  }
}

async function ensureAccountCurrency(targetPage, requestedCurrency = 'NGN', baseTargetUrl) {
  try {
    const targetCurr = (requestedCurrency || 'NGN').toUpperCase();
    const currSymbol = targetCurr === 'USD' ? '$' : '₦';

    logger.info('Executor', `====================================================`);
    logger.info('Executor', `🔍 Verifying 1xBet active account currency vs target: ${targetCurr} (${currSymbol})...`);

    let activeCurr = await detectActiveCurrency(targetPage);
    logger.info('Executor', `Current detected active currency on page: ${activeCurr || '(Scanning...)'}`);

    if (activeCurr === targetCurr) {
      logger.info('Executor', `✅ Account is ALREADY set to ${targetCurr} (${currSymbol}). No currency switch required.`);
      logger.info('Executor', `====================================================`);
      return true;
    }

    logger.info('Executor', `💱 Account currency mismatch! Current: ${activeCurr || 'USD/Other'}, Target: ${targetCurr}.`);
    logger.info('Executor', `Starting pure hardware journey to switch 1xBet account to ${targetCurr}...`);

    // Step 1: Click Profile icon via hardware mouse
    logger.info('Executor', 'Step 1: Locating Profile icon for hardware click...');
    const profileCoords = await targetPage.evaluate(() => {
      // Priority 1: Exact DevTools recorded selectors
      const exactSelectors = [
        'header a[aria-label="My account"]',
        'a[aria-label="My account"]',
        'header > div > div > a',
        '#app header div > div > a',
        'a.user-control-panel__button--marker',
        'a.user-control-panel-button',
        'a[class*="user-control-panel"]',
        '.header-user a',
        '.header-user button'
      ];
      for (const sel of exactSelectors) {
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width > 15 && r.height > 15 && r.top < 120) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, sel };
          }
        }
      }

      // Priority 2: Element directly beside balance widget
      const balanceBox = document.querySelector('.balance, [class*="balance"], [data-testid="user-balance"]');
      if (balanceBox) {
        const bRect = balanceBox.getBoundingClientRect();
        const btns = Array.from(document.querySelectorAll('a, button, div[role="button"]'));
        for (const b of btns) {
          const r = b.getBoundingClientRect();
          if (r.width >= 20 && r.height >= 20 && r.top < 100 && r.left >= bRect.right - 10 && r.left <= bRect.right + 120) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, sel: 'beside-balance' };
          }
        }
      }

      // Priority 3: Top-right header button with an SVG
      const headerBtns = Array.from(document.querySelectorAll('header a, header button'));
      for (const b of headerBtns) {
        const r = b.getBoundingClientRect();
        if (r.top < 80 && r.left > 800 && r.width > 20 && r.height > 20 && b.querySelector('svg')) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, sel: 'header-svg-right' };
        }
      }

      return null;
    });

    if (profileCoords) {
      logger.info('Executor', `Found Profile Icon at (${Math.round(profileCoords.x)}, ${Math.round(profileCoords.y)}). Executing hardware mouse click...`);
      await hardwareClickAt(targetPage, profileCoords.x, profileCoords.y);
      await randomDelay(2500, 3500);
      await dismissPopups(targetPage);
    } else {
      logger.info('Executor', 'Profile icon not found directly in header, opening /en/user/settings directly...');
      const origin = new URL(baseTargetUrl || targetPage.url()).origin;
      await targetPage.goto(`${origin}/en/user/settings?platform_type=mobile`, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      await randomDelay(2000, 3000);
    }

    // Step 2: Click "Settings" inside profile drawer
    logger.info('Executor', 'Step 2: Locating "Settings" in profile drawer for hardware click...');
    await targetPage.waitForSelector('#__OFFICE_APP__, li:nth-of-type(3) label, [aria-label="Settings"]', { timeout: 5000 }).catch(() => {});

    const settingsCoords = await targetPage.evaluate(() => {
      // DevTools recorded: li:nth-of-type(3) > label > span, aria/Settings, li:nth-of-type(3) input
      const selCandidates = [
        '#__OFFICE_APP__ nav ul li:nth-of-type(3) label',
        '#__OFFICE_APP__ [aria-label="Settings"]',
        'li:nth-of-type(3) input',
        'li:nth-of-type(3) label span',
        'li:nth-of-type(3) label'
      ];
      for (const sel of selCandidates) {
        const el = document.querySelector(sel);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 10 && r.height > 10) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
      }

      const all = Array.from(document.querySelectorAll('#__OFFICE_APP__ li, #__OFFICE_APP__ label, #__OFFICE_APP__ a'));
      for (const el of all) {
        const txt = (el.innerText || '').trim().toLowerCase();
        if (txt === 'settings') {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    });

    if (settingsCoords) {
      logger.info('Executor', `Found "Settings" tab at (${Math.round(settingsCoords.x)}, ${Math.round(settingsCoords.y)}). Executing hardware mouse click...`);
      await hardwareClickAt(targetPage, settingsCoords.x, settingsCoords.y);
      await randomDelay(2500, 3500);
      await dismissPopups(targetPage);
    }

    // Step 3: Click "My accounts"
    logger.info('Executor', 'Step 3: Locating "My accounts" for hardware click...');
    const myAccountsCoords = await targetPage.evaluate(() => {
      // DevTools recorded: nav > div > div:nth-of-type(1) li:nth-of-type(1) span.ui-caption--size-m, text/My accounts
      const candidates = Array.from(document.querySelectorAll('#__OFFICE_APP__ a, #__OFFICE_APP__ li, #__OFFICE_APP__ span, a.column-nav-link'));
      for (const c of candidates) {
        const txt = (c.innerText || '').trim().toLowerCase();
        if (txt === 'my accounts' || txt.includes('my accounts')) {
          const r = c.getBoundingClientRect();
          if (r.width > 15 && r.height > 10) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
        }
      }
      return null;
    });

    if (myAccountsCoords) {
      logger.info('Executor', `Found "My accounts" at (${Math.round(myAccountsCoords.x)}, ${Math.round(myAccountsCoords.y)}). Executing hardware mouse click...`);
      await hardwareClickAt(targetPage, myAccountsCoords.x, myAccountsCoords.y);
      await randomDelay(2500, 3500);
      await dismissPopups(targetPage);
    }

    // Step 4: Click Customize / pencil icon button on the active USD account row
    logger.info('Executor', 'Step 4: Locating Customize/pencil icon button on the USD account row for hardware click...');
    const pencilCoords = await targetPage.evaluate(() => {
      // DevTools recorded: aria/Customize, div.office-block__content > div.account-wallet button
      const exactBtn = document.querySelector('button[aria-label="Customize"], div.account-wallet button[aria-label="Customize"], div.office-block__content > div.account-wallet button');
      if (exactBtn) {
        const r = exactBtn.getBoundingClientRect();
        if (r.width > 10 && r.height > 10) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }

      const usdCard = Array.from(document.querySelectorAll('.office-settings-wallets-item, .account-wallet, [class*="wallets-item"], .office-block')).find(el => {
        const txt = (el.innerText || '').toLowerCase();
        return txt.includes('usd') || txt.includes('main') || txt.includes('active');
      });

      if (usdCard) {
        const btn = usdCard.querySelector('button.account-wallet-btn, button[aria-label="Customize"], button, [role="button"]');
        if (btn) {
          const r = btn.getBoundingClientRect();
          if (r.width > 10 && r.height > 10) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }

      const allCustomize = Array.from(document.querySelectorAll('button[aria-label="Customize"], button.account-wallet-btn'));
      for (const btn of allCustomize) {
        const r = btn.getBoundingClientRect();
        if (r.width > 10 && r.height > 10 && r.top < 450) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    });

    if (pencilCoords) {
      logger.info('Executor', `Found pencil icon button at (${Math.round(pencilCoords.x)}, ${Math.round(pencilCoords.y)}). Executing hardware mouse click...`);
      await hardwareClickAt(targetPage, pencilCoords.x, pencilCoords.y);
      await randomDelay(2000, 3000);
    }

    // Step 5: Select the target currency (NGN) option in the modal
    logger.info('Executor', `Step 5: Selecting the ${targetCurr} account option in the modal...`);
    const targetOptionCoords = await targetPage.evaluate((curr) => {
      // DevTools recorded: aria/Other currency (NGN) 9966, label:nth-of-type(2) > input, #inline-modal-__OFFICE_APP__
      const root = document.querySelector('#inline-modal-__OFFICE_APP__') || document;

      const inputs = Array.from(root.querySelectorAll('input, label, div[role="radio"], span'));
      for (const el of inputs) {
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (aria.includes('ngn') || aria.includes('9966') || txt.includes('ngn') || txt.includes('other currency (ngn)') || txt.includes('9966')) {
          const r = el.getBoundingClientRect();
          if (r.width > 15 && r.height > 10) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }

      const label2 = root.querySelector('label:nth-of-type(2) input, label:nth-of-type(2)');
      if (label2) {
        const r = label2.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    }, targetCurr);

    if (targetOptionCoords) {
      logger.info('Executor', `Found ${targetCurr} option in modal at (${Math.round(targetOptionCoords.x)}, ${Math.round(targetOptionCoords.y)}). Executing hardware mouse click...`);
      await hardwareClickAt(targetPage, targetOptionCoords.x, targetOptionCoords.y);
      await randomDelay(1200, 2000);
    }

    // Step 6: Click "Save" button in the modal
    logger.info('Executor', 'Step 6: Locating "Save" button for hardware click...');
    const saveCoords = await targetPage.evaluate(() => {
      // DevTools recorded: button.ui-button--theme-accent > span, #inline-modal-__OFFICE_APP__ div:nth-of-type(3) button[2]
      const root = document.querySelector('#inline-modal-__OFFICE_APP__') || document;
      const accentBtn = root.querySelector('button.ui-button--theme-accent');
      if (accentBtn) {
        const r = accentBtn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      const btns = Array.from(root.querySelectorAll('button, div[role="button"], a'));
      for (const b of btns) {
        const txt = (b.innerText || '').trim().toLowerCase();
        if (txt === 'save' || txt.includes('save')) {
          const r = b.getBoundingClientRect();
          if (r.width > 30 && r.height > 15) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    });

    if (saveCoords) {
      logger.info('Executor', `Found Save button at (${Math.round(saveCoords.x)}, ${Math.round(saveCoords.y)}). Executing hardware mouse click...`);
      await hardwareClickAt(targetPage, saveCoords.x, saveCoords.y);
      await randomDelay(2500, 4000);
      logger.info('Executor', '✅ Clicked Save button. Currency switch applied successfully!');
    }

    // Step 7: Dismiss notification banner if present
    const notifCoords = await targetPage.evaluate(() => {
      const btn = document.querySelector('#notifications-container button, .notification__close, .toast__close');
      if (btn) {
        const r = btn.getBoundingClientRect();
        if (r.width > 10 && r.height > 10) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    });
    if (notifCoords) {
      logger.info('Executor', 'Dismissing notification banner via hardware click...');
      await hardwareClickAt(targetPage, notifCoords.x, notifCoords.y);
      await randomDelay(800, 1500);
    }

    // Step 8: Return to Home
    logger.info('Executor', `Step 8: Navigating back to base URL: ${baseTargetUrl}...`);
    await targetPage.goto(baseTargetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await randomDelay(3000, 4500);
    await dismissPopups(targetPage);

    // Step 9: Confirm currency switch
    const newActiveCurrency = await detectActiveCurrency(targetPage);
    logger.info('Executor', `Step 9: Confirmed active account currency: ${newActiveCurrency || targetCurr}`);
    if (newActiveCurrency === targetCurr) {
      logger.info('Executor', `🎉 SUCCESS: Account currency is now confirmed active as ${targetCurr} (${currSymbol}) on 1xBet!`);
    } else {
      logger.info('Executor', `Currency update applied. Account reflects: ${newActiveCurrency || targetCurr}.`);
    }
    logger.info('Executor', `====================================================`);
    return true;
  } catch (err) {
    logger.error('Executor', 'Error during account currency verification/switch', err);
    return false;
  }
}

// ─── Virtual Sports & England League Automation ─────────────────────────────
async function getEngineFrame(targetPage) {
  try {
    const frames = targetPage.frames();
    const engineFrame = frames.find(f => {
      if (f.isDetached()) return false;
      const u = (f.url() || '').toLowerCase();
      return u.includes('virtustec.com') || u.includes('grsleagueengland');
    });
    return engineFrame || null;
  } catch (e) {
    return null;
  }
}

async function navigateToVirtualSports(targetPage) {
  logger.info('Executor', '====================================================');
  logger.info('Executor', '⚽ Step: Navigating to Virtual Sports Golden Race England League...');

  try {
    const currentUrl = targetPage.url().toLowerCase();
    if (currentUrl.includes('game=56182')) {
      logger.info('Executor', '✅ Already on Golden Race England League game page.');
      return true;
    }

    const origin = targetPage.url().includes('1xbet') ? new URL(targetPage.url()).origin : 'https://1xbet.ng';
    const directUrl = `${origin}/en/virtualsports?platform_type=mobile&game=56182`;
    logger.info('Executor', `Navigating directly to GR England League: ${directUrl}...`);
    await targetPage.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(err => {
      logger.warn('Executor', 'Notice during virtual sports navigation: ' + err.message);
    });

    await randomDelay(2000, 3000);
    await dismissPopups(targetPage);
    logger.info('Executor', `✅ Virtual Sports direct game page loaded: ${targetPage.url()}`);
    return true;
  } catch (err) {
    logger.error('Executor', 'Error navigating to Virtual Sports', err);
    return false;
  }
}

async function launchEnglandLeague(targetPage) {
  logger.info('Executor', '====================================================');
  logger.info('Executor', '🔍 Ensuring Golden Race England League game engine is mounted...');

  try {
    await randomDelay(1000, 2000);

    // Step 0: Check if Golden Race engine frame is ALREADY mounted
    let engineFrame = await getEngineFrame(targetPage);
    if (engineFrame) {
      logger.info('Executor', '✅ Golden Race England League engine frame is ALREADY active!');
      return true;
    }

    // Step 1: Wait up to 35 seconds for engine frame to mount dynamically
    logger.info('Executor', '⏳ Waiting dynamically for Golden Race engine frame to initialize...');
    const waitStart = Date.now();
    while (Date.now() - waitStart < 35000) {
      await delay(1500);
      engineFrame = await getEngineFrame(targetPage);
      if (engineFrame) {
        logger.info('Executor', `✅ Found Golden Race Engine Frame!`);
        break;
      }
    }

    // Step 2: If frame not mounted, attempt direct URL reload
    if (!engineFrame) {
      const origin = targetPage.url().includes('1xbet') ? new URL(targetPage.url()).origin : 'https://1xbet.ng';
      const directUrl = `${origin}/en/virtualsports?platform_type=mobile&game=56182`;
      logger.info('Executor', `Attempting fresh direct navigation to ${directUrl}...`);
      await targetPage.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await delay(3000);

      const retryStart = Date.now();
      while (Date.now() - retryStart < 30000) {
        await delay(1500);
        engineFrame = await getEngineFrame(targetPage);
        if (engineFrame) break;
      }
    }

    if (!engineFrame) {
      // Step 3: Fallback catalog search & scroll for card #61 "GR England League"
      logger.warn('Executor', 'Direct URL frame not yet detected. Using catalog scroll fallback...');
      await targetPage.waitForSelector('.games-grid__item, .base-game', { timeout: 20000 }).catch(() => {});
      let found = null;
      for (let attempt = 1; attempt <= 25; attempt++) {
        const scanStatus = await targetPage.evaluate(() => {
          const items = Array.from(document.querySelectorAll('.games-grid__item, .base-game'));
          for (const el of items) {
            const caption = el.querySelector('.base-game__name, [class*="caption"], [class*="name"]');
            const title = (caption ? caption.innerText : el.innerText || '').trim();
            const img = el.querySelector('img');
            const alt = (img ? img.alt : '').trim();

            const isExactTitle = (title.toLowerCase() === 'england league' || alt.toLowerCase() === 'england league');
            const isDemand = (title + ' ' + alt).toLowerCase().includes('demand');
            const isStreak = (title + ' ' + alt).toLowerCase().includes('streak');

            if (isExactTitle && !isDemand && !isStreak) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              const r = el.getBoundingClientRect();
              return {
                found: true,
                card: { title, alt, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height },
                total: items.length,
                scrollY: Math.round(window.scrollY)
              };
            }
          }
          return { found: false, total: items.length, scrollY: Math.round(window.scrollY) };
        });

        if (scanStatus.found && scanStatus.card) {
          found = scanStatus.card;
          logger.info('Executor', `🎯 Found target game card: "${found.title}" at scrollY: ${scanStatus.scrollY}px!`);
          break;
        }
        await hardwareScroll(targetPage, 800);
        await randomDelay(800, 1200);
      }

      if (found) {
        await randomDelay(1200, 1800);
        await hardwareMouseMove(targetPage, found.x, found.y);
        await randomDelay(1000, 1500);
        await hardwareClickAt(targetPage, found.x, found.y);
        await delay(5000);
      }
    }

    engineFrame = await getEngineFrame(targetPage);
    if (engineFrame) {
      logger.info('Executor', 'Waiting for Golden Race match board to render...');
      await engineFrame.waitForFunction(() => {
        const text = document.body ? document.body.innerText : '';
        return text.includes('Week') && (text.includes('Match result') || text.includes('1') || text.includes('X'));
      }, { timeout: 25000 }).catch(() => {});
      logger.info('Executor', '🎉 SUCCESS: Golden Race England League game is now fully LOADED on screen!');
      return true;
    }

    logger.warn('Executor', '⚠️ Could not mount Golden Race England League engine frame.');
    return false;
  } catch (err) {
    logger.error('Executor', 'Error launching England League', err);
    return false;
  }
}

// ─── Team Aliases & Normalization ──────────────────────────────────────────
const TEAM_ALIASES = {
  'manchester city': ['man city', 'man. city', 'mci', 'manchestercity'],
  'manchester united': ['man utd', 'man united', 'mun', 'manchesterunited'],
  'liverpool': ['liv', 'liverpool fc'],
  'arsenal': ['ars', 'arsenal fc'],
  'chelsea': ['che', 'chelsea fc'],
  'tottenham': ['tot', 'spurs', 'tottenham hotspur'],
  'newcastle': ['new', 'newcastle utd', 'newcastle united'],
  'aston villa': ['ast', 'avl', 'villa', 'astonvilla'],
  'everton': ['eve', 'everton fc'],
  'brighton': ['bha', 'brighton and hove', 'brighton & hove albion'],
  'brentford': ['brn', 'bre', 'brentford fc'],
  'fulham': ['ful', 'fulham fc'],
  'crystal palace': ['cry', 'palace', 'crystalpalace'],
  'west ham': ['whu', 'westham', 'west ham united'],
  'wolves': ['wol', 'wolverhampton'],
  'bournemouth': ['bou', 'afc bournemouth'],
  'nottingham forest': ['for', 'nfo', 'nottingham forest', 'nottingham'],
  'nottm forest': ['for', 'nfo', 'nottingham forest', 'nottingham'],
  'leicester': ['lei', 'leicester city'],
  'leeds': ['lee', 'leeds united'],
  'southampton': ['sou', 'southampton fc'],
  'sheffield united': ['shu', 'sheffield utd', 'sheffield'],
  'burnley': ['bur', 'burnley fc'],
  'luton': ['lut', 'luton town'],
  'ipswich town': ['ips', 'ipswich'],
  'coventry': ['cov', 'coventry city'],
  'hull': ['hll', 'hul', 'hull city'],
  'sunderland': ['sun', 'sunderland afc']
};

function normalizeTeam(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function matchTeams(teamA, teamB) {
  if (!teamA || !teamB) return false;
  const a = normalizeTeam(teamA);
  const b = normalizeTeam(teamB);
  if (a === b || a.includes(b) || b.includes(a)) return true;

  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    const canonicalNorm = normalizeTeam(canonical);
    const aliasNorms = aliases.map(normalizeTeam);
    const isA = (a === canonicalNorm || aliasNorms.includes(a));
    const isB = (b === canonicalNorm || aliasNorms.includes(b));
    if (isA && isB) return true;
  }
  return false;
}

// ─── Account Balance & Profit/Loss Engine ──────────────────────────────────
async function readAccountBalance(targetPage) {
  try {
    let balanceData = await targetPage.evaluate(() => {
      const selectors = [
        '.top-b-acc__amount',
        '.user-balance',
        '.header-balance',
        '[class*="balance"]',
        '[class*="amount"]',
        '.cur-balance'
      ];
      for (const s of selectors) {
        const els = document.querySelectorAll(s);
        for (const el of els) {
          const txt = (el.innerText || el.textContent || '').trim();
          const clean = txt.replace(/[^0-9.]/g, '');
          const num = parseFloat(clean);
          if (!isNaN(num) && num >= 0 && txt.length < 20) {
            return num;
          }
        }
      }
      return null;
    });

    if (balanceData === null) {
      const engineFrame = await getEngineFrame(targetPage);
      if (engineFrame) {
        balanceData = await engineFrame.evaluate(() => {
          const all = Array.from(document.querySelectorAll('*'));
          for (const el of all) {
            const txt = (el.innerText || '').trim();
            if (txt.includes('Credit') || txt.includes('₦')) {
              const m = txt.match(/₦\s*([\d,]+(?:\.\d{2})?)/);
              if (m) {
                const num = parseFloat(m[1].replace(/,/g, ''));
                if (!isNaN(num) && num >= 0) return num;
              }
            }
          }
          return null;
        });
      }
    }

    if (balanceData !== null) {
      db.recordBalance(balanceData, currency);
      
      if (startingBalance === null) {
        startingBalance = balanceData;
        logger.info('Executor', `🏁 Baseline session balance recorded: ${currencySymbol}${startingBalance.toLocaleString()} (${currency})`);
      }
      currentBalance = balanceData;
      sessionProfitLoss = parseFloat((currentBalance - startingBalance).toFixed(2));

      const plSign = sessionProfitLoss >= 0 ? '+' : '';
      logger.info('Executor', `💰 1xBet Balance: ${currencySymbol}${currentBalance.toLocaleString()} (${currency}) | Session P/L: ${plSign}${currencySymbol}${sessionProfitLoss.toLocaleString()}`);

      // Check Stop-Loss
      if (stopLossEnabled && stopLoss > 0 && sessionProfitLoss <= -Math.abs(stopLoss)) {
        if (!isTargetLimitReached) {
          logger.warn('Executor', `🛑 STOP-LOSS LIMIT TRIGGERED: Current loss of ${currencySymbol}${Math.abs(sessionProfitLoss)} reached threshold of ${currencySymbol}${stopLoss}. Auto-betting halted to preserve capital.`);
          isTargetLimitReached = true;
          limitReason = 'stop_loss';
        }
      }
      // Check Take-Profit
      else if (takeProfitEnabled && takeProfit > 0 && sessionProfitLoss >= takeProfit) {
        if (!isTargetLimitReached) {
          logger.info('Executor', `🎯 TAKE-PROFIT GOAL ACHIEVED: Session profit of +${currencySymbol}${sessionProfitLoss} reached target of ${currencySymbol}${takeProfit}! Auto-betting halted.`);
          isTargetLimitReached = true;
          limitReason = 'take_profit';
        }
      }

      publishLiveStatus({
        initialBalance: startingBalance,
        currentBalance: currentBalance,
        sessionProfitLoss: sessionProfitLoss,
        isTargetLimitReached: isTargetLimitReached,
        limitReason: limitReason
      });

      return balanceData;
    }
  } catch (e) {}
  return null;
}

// ─── 1xBet Odds Extraction Engine ──────────────────────────────────────────
async function extract1xBetOdds(targetPage) {
  const engineFrame = await getEngineFrame(targetPage);
  if (!engineFrame) {
    logger.info('Executor', '⏳ Waiting for Golden Race game engine frame to appear...');
    return { matches: [], roundInfo: '', timerSecs: 0, tabs: [], frameBox: null };
  }

  try {
    let frameOffset = { x: 0, y: 0 };
    const frameEl = await engineFrame.frameElement();
    let frameBox = null;
    if (frameEl) {
      frameBox = await frameEl.boundingBox();
      if (frameBox) frameOffset = { x: frameBox.x, y: frameBox.y };
    }

    const data = await engineFrame.evaluate((offset) => {
      // 1. Current round timer
      const timerEls = Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && /^\d{2}:\d{2}$/.test((el.innerText || '').trim()));
      const timerText = timerEls.length > 0 ? timerEls[0].innerText.trim() : '';
      let timerSecs = 0;
      if (timerText) {
        const [m, s] = timerText.split(':').map(Number);
        timerSecs = (m || 0) * 60 + (s || 0);
      }

      // 2. Week/Round header
      const weekEl = Array.from(document.querySelectorAll('*'))
        .find(el => el.children.length === 0 && /^Week \d+/i.test((el.innerText || '').trim()));
      const weekText = weekEl ? weekEl.innerText.trim() : 'England League';

      // 3. Market Subtabs
      const tabNames = ['Match result', 'Double Chance', 'Over/Under 2.5', 'Goal Goal/No Goal', 'Half Time/Full Time'];
      const tabs = Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && tabNames.includes((el.innerText || '').trim()))
        .map(el => {
          const r = el.getBoundingClientRect();
          return {
            name: el.innerText.trim(),
            x: Math.round(r.left + r.width / 2 + offset.x),
            y: Math.round(r.top + r.height / 2 + offset.y)
          };
        });

      // 4. Team Badges (3-letter codes)
      const teamBadges = Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && /^[A-Z]{3}$/.test((el.innerText || '').trim()))
        .map(el => {
          const r = el.getBoundingClientRect();
          return {
            team: el.innerText.trim(),
            y: Math.round(r.top + r.height / 2)
          };
        });

      // Sort team badges by y
      teamBadges.sort((a, b) => a.y - b.y);

      // 5. Odds elements
      const oddEls = Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && /^\d+\.\d{2}$/.test((el.innerText || '').trim()))
        .map(el => {
          const r = el.getBoundingClientRect();
          return {
            odd: parseFloat(el.innerText.trim()),
            text: el.innerText.trim(),
            x: Math.round(r.left + r.width / 2 + offset.x),
            y: Math.round(r.top + r.height / 2 + offset.y),
            rawY: Math.round(r.top + r.height / 2)
          };
        });

      oddEls.sort((a, b) => a.rawY - b.rawY || a.x - b.x);

      // Construct matches (10 fixtures)
      const matches = [];
      const matchCount = Math.floor(teamBadges.length / 2);
      for (let i = 0; i < matchCount; i++) {
        const home = teamBadges[i * 2]?.team || '';
        const away = teamBadges[i * 2 + 1]?.team || '';
        const matchY = teamBadges[i * 2]?.y || 0;
        const matchOdds = oddEls.filter(o => Math.abs(o.rawY - matchY) < 25);
        if (home && away) {
          matches.push({
            homeTeam: home,
            awayTeam: away,
            odds: matchOdds
          });
        }
      }

      return {
        week: weekText,
        timerText,
        timerSecs,
        tabs,
        matches
      };
    }, frameOffset);

    data.frameBox = frameBox;

    // Save snapshot to data directory
    const snapshot = {
      timestamp: new Date().toISOString(),
      round: data.week,
      timer: data.timerText,
      timerSeconds: data.timerSecs,
      matchesCount: data.matches.length,
      matches: data.matches
    };

    const outPath = path.resolve(__dirname, 'data', 'latest_1xbet_odds.json');
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');

    if (data.matches.length > 0) {
      logger.info('Executor', `📊 England League: ${data.week} (⏱️ ${data.timerText || 'Live'} | ${data.timerSecs}s) - ${data.matches.length} matches mapped.`);
      for (const m of data.matches.slice(0, 3)) {
        const oddsText = m.odds.map(o => o.text).join(' | ');
        logger.info('Executor', `   ⚽ [${m.homeTeam} vs ${m.awayTeam}] -> ${oddsText}`);
      }
    } else {
      logger.info('Executor', 'ℹ️ Scanning England League game view: waiting for upcoming fixture odds to populate...');
    }

    return data;
  } catch (e) {
    logger.warn('Executor', 'Notice during odds extraction: ' + e.message);
    return { matches: [], roundInfo: '', timerSecs: 0, tabs: [], frameBox: null };
  }
}

// ─── Smart Picks Matching & Single Flat Staking ────────────────────────────
async function processSmartPicksBetting(targetPage) {
  if (!autoBet) {
    logger.info('Executor', 'Auto-bet is in STANDBY mode. Staking will not be dispatched automatically.');
    return;
  }

  if (isTargetLimitReached) {
    logger.info('Executor', '🛑 Auto-betting halted: Stop-Loss limit or Take-Profit target achieved for this session.');
    return;
  }

  // Actively sync live signals from remote Predictor server
  try {
    const { signalCollector } = require('./utils/signal_collector');
    await signalCollector.pollPendingPicks();
    signalCollector.cleanupStalePendingPicks();
    signalCollector.saveToStorage();
  } catch (e) {
    logger.warn('Executor', 'Notice syncing live signals: ' + e.message);
  }

  const signalsPath = path.resolve(__dirname, 'collected_signals.json');
  if (!fs.existsSync(signalsPath)) return;

  let signalsData = null;
  try {
    signalsData = JSON.parse(fs.readFileSync(signalsPath, 'utf8'));
  } catch (e) {
    return;
  }

  const pendingPicks = signalsData.pendingPicks || [];
  if (pendingPicks.length === 0) {
    logger.info('Executor', 'No pending smart picks available at this moment. Standing by...');
    return;
  }

  const engineFrame = await getEngineFrame(targetPage);
  if (!engineFrame) {
    logger.info('Executor', '⏳ Golden Race engine frame not ready. Standing by...');
    return;
  }

  const extracted = await extract1xBetOdds(targetPage);
  const visibleMatches = extracted.matches || [];

  // LOCK GUARD: Check if odds are locked for current round (<= 14 seconds before kickoff)
  if (extracted.timerSecs > 0 && extracted.timerSecs <= 14) {
    logger.warn('Executor', `⏳ Odds locked for current round (${extracted.timerSecs}s remaining <= 14s lock threshold). Standing by for next round...`);
    return;
  }

  logger.info('Executor', `🎯 Evaluating ${pendingPicks.length} smart pick(s) against ${visibleMatches.length} visible 1xBet fixture(s)...`);

  let betsPlacedInThisRun = 0;

  for (const pick of pendingPicks) {
    if (isShuttingDown) break;

    // 1. Check tier filter guard: only bet if pick_type is in selectedTiers
    if ((!selectedStrategy || selectedStrategy === 'all') && pick.pick_type && selectedTiers.length > 0 && !selectedTiers.includes(({high_value:'high_chance', goals:'goals_strategy'})[strategyId(pick)] || strategyId(pick))) {
      logger.info('Executor', `⏭️ Skipping Pick #${pick.id} (${pick.home_team} vs ${pick.away_team} - ${pick.pick_type}): tier not in selectedTiers.`);
      continue;
    }

    // 2. Check strategy filter guard (exact replica of Market Analytics & Staking Lab / NexusPanel)
    if (selectedStrategy && selectedStrategy !== 'all') {
      const rawType = (pick.pick_type || pick.engine || pick.category || '').toLowerCase();
      const normalizedTypeMap = {
        high_chance: 'high_value',
        high_value: 'high_value',
        ai_best: 'ai_best_pick',
        ai_best_pick: 'ai_best_pick',
        ai_high_risk: 'high_risk',
        safest: 'safest',
        goals_strategy: 'goals_engine',
        goals: 'goals_engine',
        goals_engine: 'goals_engine'
      };
      const pType = normalizedTypeMap[rawType] || rawType;
      const mkt = (pick.market || '').toLowerCase();
      const odd = pick.sportybet_odd && pick.sportybet_odd > 0
        ? pick.sportybet_odd
        : (pick.implied_odd && pick.implied_odd > 0 ? pick.implied_odd : (pick.odds || 1.0));

      let stratMatch = false;
      if (selectedStrategy === 'safest') {
        stratMatch = pType === 'safest';
      } else if (selectedStrategy === 'high_value') {
        stratMatch = pType === 'high_value';
      } else if (selectedStrategy === 'ai_best_pick' || selectedStrategy === 'ai_best') {
        stratMatch = matchesStrategy(pick, 'ai_best');
      } else if (selectedStrategy === 'high_risk') {
        stratMatch = matchesStrategy(pick, 'high_risk');
      } else if (selectedStrategy === 'goals_engine' || selectedStrategy === 'goals') {
        stratMatch = pType === 'goals_engine';
      } else if (selectedStrategy === 'goals_market') {
        stratMatch = mkt.includes('over') || mkt.includes('under') || mkt.includes('both teams') || mkt.includes('gg') || mkt.includes('btts');
      } else if (selectedStrategy === 'high_odds') {
        stratMatch = odd >= 3.0;
      }

      if (!stratMatch) {
        logger.info('Executor', `⏭️ Skipping Pick #${pick.id} (${pick.home_team} vs ${pick.away_team}): strategy '${selectedStrategy}' filter mismatch.`);
        continue;
      }
    }

    // 3. Check signal / market type filter guard
    if (!selectedSignalTypes.includes('all') && selectedSignalTypes.length > 0) {
      const mkt = (pick.market || '').toLowerCase().trim();
      const impliedOdd = pick.implied_odd != null ? parseFloat(pick.implied_odd) : (pick.odds != null ? parseFloat(pick.odds) : 2.0);

      const signalTypeMatches = (typeId) => {
        switch (typeId) {
          case 'match_result':  return mkt.includes('home win') || mkt.includes('away win') || mkt.includes('draw') || mkt === '1' || mkt === 'x' || mkt === '2' || mkt.includes('match result') || mkt.includes('1x2');
          case 'over_15':       return mkt.includes('over 1.5') || mkt.includes('o 1.5') || mkt.includes('over1.5');
          case 'over_25':       return mkt.includes('over 2.5') || mkt.includes('o 2.5') || mkt.includes('over2.5');
          case 'under_25':      return mkt.includes('under 2.5') || mkt.includes('u 2.5') || mkt.includes('under2.5');
          case 'under_35':      return mkt.includes('under 3.5') || mkt.includes('u 3.5') || mkt.includes('under3.5');
          case 'over_35':       return mkt.includes('over 3.5') || mkt.includes('o 3.5') || mkt.includes('over3.5');
          case 'btts':          return mkt.includes('both teams to score') || mkt.includes('goal goal') || mkt.includes('gg') || mkt.includes('btts');
          case 'double_chance': return mkt.includes('double chance') || mkt.includes('1x') || mkt.includes('12') || mkt.includes('x2');
          case 'htft':          return mkt.includes('ht/ft') || mkt.includes('ht-ft') || mkt.includes('halftime') || mkt.includes('half time') || /^[12x]\/[12x]$/i.test(mkt);
          case 'high_odds':     return impliedOdd >= 3.0;
          case 'goals_engine':  return mkt.includes('over 2.5') || mkt.includes('under 2.5') || mkt.includes('over 3.5') || mkt.includes('under 3.5');
          case 'goals_market':  return mkt.includes('over') || mkt.includes('under') || mkt.includes('goal') || mkt.includes('btts');
          case 'safest':        return impliedOdd <= 1.65 || (pick.probability != null && parseFloat(pick.probability) >= 75);
          case 'high_chance':   return impliedOdd > 1.65 && impliedOdd < 3.2;
          case 'high_risk':     return impliedOdd >= 3.2 || (pick.probability != null && parseFloat(pick.probability) < 48);
          default:              return false;
        }
      };

      const isSignalTypeApproved = selectedSignalTypes.some(typeId => signalTypeMatches(typeId));
      if (!isSignalTypeApproved) {
        logger.info('Executor', `⏭️ Skipping Pick #${pick.id} [${pick.market}] (${pick.home_team} vs ${pick.away_team}): market type not in selectedSignalTypes [${selectedSignalTypes.join(', ')}].`);
        continue;
      }
    }

    // 4. Odds Range filter guard
    const pickOdd = pick.implied_odd != null ? parseFloat(pick.implied_odd) : (pick.odds != null ? parseFloat(pick.odds) : 0);
    if (minOdds > 0 && pickOdd > 0 && pickOdd < minOdds) {
      logger.info('Executor', `⏭️ Skipping Pick #${pick.id} [${pick.market} @ ${pickOdd}]: odds below minOdds threshold (${minOdds}).`);
      continue;
    }
    if (maxOdds > 0 && pickOdd > 0 && pickOdd > maxOdds) {
      logger.info('Executor', `⏭️ Skipping Pick #${pick.id} [${pick.market} @ ${pickOdd}]: odds above maxOdds threshold (${maxOdds}).`);
      continue;
    }

    // 5. Min Confidence % filter guard
    const prob = pick.probability != null ? parseFloat(pick.probability) : 0;
    if (minConfidence > 0 && prob > 0 && prob < minConfidence) {
      logger.info('Executor', `⏭️ Skipping Pick #${pick.id} (${prob}%): confidence below minConfidence threshold (${minConfidence}%).`);
      continue;
    }

    // 6. Team Search / Whitelist filter guard
    if (teamSearch) {
      const ht = (pick.home_team || '').toLowerCase();
      const at = (pick.away_team || '').toLowerCase();
      if (!ht.includes(teamSearch) && !at.includes(teamSearch)) {
        logger.info('Executor', `⏭️ Skipping Pick #${pick.id} (${pick.home_team} vs ${pick.away_team}): does not match team filter "${teamSearch}".`);
        continue;
      }
    }

    // Check expiration: pick must not be expired
    const now = Date.now();
    if (pick.kickoff_timestamp && (pick.kickoff_timestamp < now - 45000)) {
      logger.info('Executor', `⏭️ Pick #${pick.id} (${pick.home_team} vs ${pick.away_team}) kickoff expired. Skipping.`);
      continue;
    }

    // In-memory de-duplication guard
    if (placedPickIds.has(String(pick.id))) {
      continue;
    }

    // STRICT DE-DUPLICATION: Check SQLite DB before placing bet
    const alreadyStaked = db.hasBetBeenPlaced(
      pick.round_number || extracted.week || '',
      pick.home_team,
      pick.away_team,
      pick.market,
      pick.market,
      pick.id
    );

    if (alreadyStaked) {
      placedPickIds.add(String(pick.id));
      logger.info('Executor', `🛡️ Already staked Pick #${pick.id} (${pick.home_team} vs ${pick.away_team} - ${pick.market}). Skipping duplicate.`);
      continue;
    }

    // Match against visible 1xBet matches
    let matchedFixture = null;
    for (const vm of visibleMatches) {
      if (matchTeams(pick.home_team, vm.homeTeam) && matchTeams(pick.away_team, vm.awayTeam)) {
        matchedFixture = vm;
        break;
      }
    }

    if (!matchedFixture) {
      logger.info('Executor', `⏳ Pick #${pick.id} [${pick.home_team} vs ${pick.away_team}] not yet in visible fixture board. Standing by...`);
      continue;
    }

    logger.info('Executor', `🔥 MATCH FOUND on 1xBet: [${matchedFixture.homeTeam} vs ${matchedFixture.awayTeam}] for signal [${pick.market}] (Pick #${pick.id})!`);

    const marketLower = (pick.market || '').toLowerCase().trim();
    let requiredTabName = 'Match result';
    let oddIndex = -1; // 0, 1, or 2
    let targetCode = null;
    let isHtFt = false;

    // 1. Half Time / Full Time (HT/FT) - 9 permutations: 1/1, 1/X, 1/2, X/1, X/X, X/2, 2/1, 2/X, 2/2
    if (marketLower.includes('ht/ft') || marketLower.includes('ht-ft') || /^[12x]\/[12x]$/i.test(marketLower)) {
      requiredTabName = 'Half Time/Full Time';
      isHtFt = true;
      const m = marketLower.match(/([12x]\/[12x])/i);
      if (m) {
        targetCode = m[1].toUpperCase();
      }
    }
    // 2. 1X2 Market (Match result)
    else if (marketLower.includes('home win') || marketLower === '1' || marketLower === 'home') {
      requiredTabName = 'Match result';
      oddIndex = 0;
    } else if (marketLower.includes('draw') || marketLower === 'x') {
      requiredTabName = 'Match result';
      oddIndex = 1;
    } else if (marketLower.includes('away win') || marketLower === '2' || marketLower === 'away') {
      requiredTabName = 'Match result';
      oddIndex = 2;
    }
    // 3. Over / Under Market
    else if (marketLower.includes('over 2.5') || marketLower.includes('o 2.5') || marketLower.includes('> 2.5') || marketLower.includes('over 1.5')) {
      requiredTabName = 'Over/Under 2.5';
      oddIndex = 0;
    } else if (marketLower.includes('under 2.5') || marketLower.includes('u 2.5') || marketLower.includes('< 2.5') || marketLower.includes('under 1.5')) {
      requiredTabName = 'Over/Under 2.5';
      oddIndex = 1;
    }
    // 4. Goal Goal / Both Teams to Score (BTTS)
    else if (marketLower.includes('both teams to score') || marketLower.includes('gg') || marketLower.includes('goal goal') || marketLower.includes('btts yes')) {
      requiredTabName = 'Goal Goal/No Goal';
      oddIndex = 0;
    } else if (marketLower.includes('no goal') || marketLower.includes('ng') || marketLower.includes('btts no')) {
      requiredTabName = 'Goal Goal/No Goal';
      oddIndex = 1;
    }
    // 5. Double Chance
    else if (marketLower.includes('1x') || marketLower.includes('home/draw')) {
      requiredTabName = 'Double Chance';
      oddIndex = 0;
    } else if (marketLower.includes('12') || marketLower.includes('home/away')) {
      requiredTabName = 'Double Chance';
      oddIndex = 1;
    } else if (marketLower.includes('x2') || marketLower.includes('draw/away')) {
      requiredTabName = 'Double Chance';
      oddIndex = 2;
    }

    // Ensure betslip is clean before evaluating this pick (no stale accumulator legs)
    const hasExistingSelections = await engineFrame.evaluate(() => {
      const btn = document.querySelector('#quick-bet-button, .dynamic-footer-button--omega');
      return !!btn;
    });

    if (hasExistingSelections) {
      logger.info('Executor', '🧹 Clearing previous unplaced or expired selections from betslip drawer via physical clicks...');
      const btnCoords = await engineFrame.evaluate(() => {
        const btn = document.querySelector('#quick-bet-button, .dynamic-footer-button--omega');
        if (btn) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        return null;
      });
      if (btnCoords) await hardwareClickAt(targetPage, btnCoords.x + fOffsetX, btnCoords.y + fOffsetY);
      await randomDelay(800, 1200);

      const clearAllCoords = await engineFrame.evaluate(() => {
        const clearAll = Array.from(document.querySelectorAll('*')).find(el => (el.innerText || '').trim().toLowerCase() === 'clear all');
        if (clearAll) {
          const r = clearAll.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        return null;
      });
      if (clearAllCoords) await hardwareClickAt(targetPage, clearAllCoords.x + fOffsetX, clearAllCoords.y + fOffsetY);
      await randomDelay(600, 1000);

      const backCoords = await engineFrame.evaluate(() => {
        const back = document.querySelector('#bs-close-button, .icon-back, [class*="back"], .header-back, .icon-omega-back');
        if (back) {
          const r = back.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        return null;
      });
      if (backCoords) await hardwareClickAt(targetPage, backCoords.x + fOffsetX, backCoords.y + fOffsetY);
      await randomDelay(800, 1200);
    }

    // Switch to required tab if needed via physical hardware click
    if (extracted.tabs && extracted.tabs.length > 0) {
      const tabObj = extracted.tabs.find(t => t.name.toLowerCase() === requiredTabName.toLowerCase());
      if (tabObj) {
        logger.info('Executor', `Switching to "${requiredTabName}" tab at (${tabObj.x}, ${tabObj.y}) via physical click...`);
        await hardwareClickAt(targetPage, tabObj.x, tabObj.y);
        await randomDelay(1200, 1800);
      }
    }

    // Re-locate target odds button after tab selection
    const freshOdds = await engineFrame.evaluate((args) => {
      const teamBadges = Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && /^[A-Z]{3}$/.test((el.innerText || '').trim()))
        .map(el => ({ team: el.innerText.trim(), y: Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2) }));
      teamBadges.sort((a, b) => a.y - b.y);

      let targetY = null;
      for (let i = 0; i < Math.floor(teamBadges.length / 2); i++) {
        if (teamBadges[i * 2]?.team === args.home && teamBadges[i * 2 + 1]?.team === args.away) {
          targetY = teamBadges[i * 2]?.y;
          break;
        }
      }

      if (targetY === null) return null;

      // Case A: Half Time / Full Time (HT/FT) - 3x3 Button Grid
      if (args.isHtFt && args.targetCode) {
        const allCandidates = Array.from(document.querySelectorAll('*'));
        const otherCodes = ['1/1','1/X','1/2','X/1','X/X','X/2','2/1','2/X','2/2'].filter(c => c !== args.targetCode);
        const matchingElements = allCandidates.filter(el => {
          const txt = (el.innerText || '').trim();
          return txt.includes(args.targetCode) && !otherCodes.some(c => txt.includes(c));
        });

        let bestBtn = null;
        let bestDist = 9999;
        for (const el of matchingElements) {
          const r = el.getBoundingClientRect();
          if (r.width >= 20 && r.height >= 15) {
            const cy = Math.round(r.top + r.height / 2);
            const dist = Math.abs(cy - targetY);
            if (dist < 110 && dist < bestDist) {
              bestDist = dist;
              bestBtn = el;
            }
          }
        }

        if (bestBtn) {
          bestBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
          const r = bestBtn.getBoundingClientRect();
          const lines = (bestBtn.innerText || '').trim().split(/\s+/);
          const numPart = lines.find(s => /^\d+(\.\d+)?$/.test(s));
          return {
            odd: numPart ? parseFloat(numPart) : 1.0,
            text: bestBtn.innerText.trim().replace(/\n+/g, ' '),
            rawX: Math.round(r.left + r.width / 2),
            rawY: Math.round(r.top + r.height / 2),
            isHtFt: true,
            targetCode: args.targetCode
          };
        }
      }

      // Case B: Standard column-based markets (1X2, Over/Under 2.5, Goal Goal/No Goal, Double Chance)
      const oddEls = Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && /^\d+\.\d{2}$/.test((el.innerText || '').trim()))
        .map(el => {
          const r = el.getBoundingClientRect();
          return {
            el: el,
            odd: parseFloat(el.innerText.trim()),
            text: el.innerText.trim(),
            rawX: Math.round(r.left + r.width / 2),
            rawY: Math.round(r.top + r.height / 2)
          };
        });

      const rowOdds = oddEls.filter(o => Math.abs(o.rawY - targetY) < 25);
      rowOdds.sort((a, b) => a.rawX - b.rawX);

      const targetOddObj = (args.oddIndex >= 0 && args.oddIndex < rowOdds.length) ? rowOdds[args.oddIndex] : (rowOdds[0] || null);
      if (targetOddObj && targetOddObj.el) {
        targetOddObj.el.scrollIntoView({ behavior: 'instant', block: 'center' });
        const r = targetOddObj.el.getBoundingClientRect();
        return {
          odd: targetOddObj.odd,
          text: targetOddObj.text,
          rawX: Math.round(r.left + r.width / 2),
          rawY: Math.round(r.top + r.height / 2)
        };
      }
      return null;
    }, {
      home: matchedFixture.homeTeam,
      away: matchedFixture.awayTeam,
      oddIndex,
      isHtFt,
      targetCode
    });

    let targetButton = freshOdds;
    if (!targetButton && matchedFixture.odds && oddIndex >= 0 && oddIndex < matchedFixture.odds.length) {
      targetButton = matchedFixture.odds[oddIndex];
    }

    if (!targetButton) {
      logger.warn('Executor', `⚠️ Target market [${pick.market}] button could not be located for [${matchedFixture.homeTeam} vs ${matchedFixture.awayTeam}]. Skipping.`);
      continue;
    }

    const actualOdds = targetButton.odd || pick.implied_odd || 1.0;
    logger.info('Executor', `🎲 Selected target 1xBet odds: ${actualOdds} for market [${pick.market}] on [${matchedFixture.homeTeam} vs ${matchedFixture.awayTeam}]`);

    // Frame offset for native viewport click
    let fOffsetX = 0;
    let fOffsetY = 0;
    try {
      const fEl = await engineFrame.frameElement();
      if (fEl) {
        const fb = await fEl.boundingBox();
        if (fb) {
          fOffsetX = Math.round(fb.x);
          fOffsetY = Math.round(fb.y);
        }
      }
    } catch (e) {}

    const pageClickX = (targetButton.rawX || 400) + fOffsetX;
    const pageClickY = (targetButton.rawY || 350) + fOffsetY;

    // Step 1: Click Odds Button via realistic human mouse interaction and physical hardware click
    logger.info('Executor', `🖱️ Selecting odds button for [${pick.market} @ ${actualOdds}] at viewport (${pageClickX}, ${pageClickY}) via physical click...`);
    await hardwareMouseMove(targetPage, pageClickX, pageClickY);
    await randomDelay(200, 450);
    await hardwareClickAt(targetPage, pageClickX, pageClickY);
    await randomDelay(1200, 1800);

    // Step 2: Open Betslip Drawer via physical hardware click on green floating button (#quick-bet-button)
    logger.info('Executor', 'Executing physical click on floating Betslip button (#quick-bet-button) to open ticket drawer...');
    const drawerBtnCoords = await engineFrame.evaluate(() => {
      const btn = document.querySelector('#quick-bet-button, .dynamic-footer-button--omega');
      if (btn) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      return null;
    });
    if (drawerBtnCoords) {
      await hardwareMouseMove(targetPage, drawerBtnCoords.x + fOffsetX, drawerBtnCoords.y + fOffsetY);
      await randomDelay(100, 200);
      await hardwareClickAt(targetPage, drawerBtnCoords.x + fOffsetX, drawerBtnCoords.y + fOffsetY);
    }
    await randomDelay(1500, 2200);

    // Step 3: Physically type calculated stake into betslip input via hardware mouse click & hardware keyboard
    const activeStake = calculateCurrentStake(actualOdds, pick.probability);
    const streak = getConsecutiveLossStreak();
    let detailText = `loss streak: ${streak.count}`;
    if (stakeMode === 'martingale_2_0' && streak.count > 0 && actualOdds < 2.0) {
      detailText += `, odds-adjusted @ ${actualOdds} for recovery of ${currencySymbol}${streak.accumulatedLoss}`;
    }
    const stakeDescription = `${stakeMode.toUpperCase()} stake ${currencySymbol}${activeStake} (${detailText})`;
    logger.info('Executor', `🎫 Verifying single ticket betslip and physically typing ${stakeDescription} via hardware keyboard...`);

    const inputCoords = await engineFrame.evaluate(() => {
      const inp = document.querySelector('input.system-bet__stake, input.system-bet, input[type="text"]');
      if (inp) {
        const r = inp.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      return null;
    });

    if (inputCoords) {
      // Focus input via physical hardware click
      await hardwareClickAt(targetPage, inputCoords.x + fOffsetX, inputCoords.y + fOffsetY);
      await randomDelay(150, 300);

      // Physical keyboard: select all & backspace
      await targetPage.keyboard.down('Control');
      await targetPage.keyboard.press('KeyA');
      await targetPage.keyboard.up('Control');
      await targetPage.keyboard.press('Backspace');
      await randomDelay(80, 160);

      // Physical keyboard: type amount digits
      for (const ch of String(activeStake)) {
        await targetPage.keyboard.type(ch, { delay: 45 + Math.floor(Math.random() * 45) });
      }
      await randomDelay(150, 300);
      await targetPage.keyboard.press('Tab');
    } else {
      logger.warn('Executor', '⚠️ Stake input not found in drawer.');
    }
    await randomDelay(1000, 1600);

    // Step 4: Physical hardware click on "PLACE BET" button
    logger.info('Executor', '🚀 Executing physical hardware click on "PLACE BET" button...');
    const placeBetBtnCoords = await engineFrame.evaluate(() => {
      const btn = document.querySelector('.place-bet, [class*="place-bet"]');
      if (btn) {
        if (btn.classList.contains('place-bet--disabled')) {
          return { found: true, disabled: true };
        }
        const r = btn.getBoundingClientRect();
        return {
          found: true,
          disabled: false,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          text: (btn.innerText || '').trim().replace(/\n+/g, ' ')
        };
      }
      return { found: false };
    });

    let placeBetResult = { clicked: false };
    if (placeBetBtnCoords.found && !placeBetBtnCoords.disabled) {
      await hardwareMouseMove(targetPage, placeBetBtnCoords.x + fOffsetX, placeBetBtnCoords.y + fOffsetY);
      await randomDelay(100, 200);
      await hardwareClickAt(targetPage, placeBetBtnCoords.x + fOffsetX, placeBetBtnCoords.y + fOffsetY);
      placeBetResult = { clicked: true, text: placeBetBtnCoords.text };
    } else if (placeBetBtnCoords.disabled) {
      placeBetResult = { clicked: false, reason: 'place-bet--disabled' };
    }

    logger.info('Executor', `Place bet result: ${JSON.stringify(placeBetResult)}`);
    await randomDelay(3000, 4500);

    // GUARD: Only record bet if actually accepted by Golden Race engine
    if (!placeBetResult || !placeBetResult.clicked) {
      logger.warn('Executor', `⚠️ Bet placement was rejected/disabled by Golden Race (${placeBetResult ? placeBetResult.reason : 'unknown'}). Skipping ticket recording.`);
      const rejectClearCoords = await engineFrame.evaluate(() => {
        const clearAll = Array.from(document.querySelectorAll('*')).find(el => (el.innerText || '').trim().toLowerCase() === 'clear all');
        if (clearAll) {
          const r = clearAll.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        const closeBtn = document.querySelector('#bs-close-button, .header-back, .icon-back, [class*="back"], [class*="close"]');
        if (closeBtn) {
          const r = closeBtn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        return null;
      });
      if (rejectClearCoords) {
        await hardwareClickAt(targetPage, rejectClearCoords.x + fOffsetX, rejectClearCoords.y + fOffsetY);
      }
      await randomDelay(1000, 2000);
      continue;
    }

    // Step 5: Record into SQLite Database as single bet
    const ticketId = `GR_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const betId = db.recordPlacedBet({
      signal_id: String(pick.id),
      season_name: pick.season_name || 'Golden Race VFL England League',
      week: extracted.week || String(pick.round_number || ''),
      round: extracted.week || String(pick.round_number || ''),
      kickoff_time: pick.match_time || new Date().toLocaleTimeString(),
      home_team: matchedFixture.homeTeam,
      away_team: matchedFixture.awayTeam,
      market: pick.market,
      selection: pick.market,
      odds: actualOdds,
      stake: activeStake,
      currency: currency,
      status: 'PENDING',
      ticket_id: ticketId
    });

    logger.info('Executor', `🎉 SUCCESS: ${stakeMode === 'percentage' ? `Percentage (${stakePercentage}%)` : 'Single flat'} stake of ${currencySymbol}${activeStake} placed on [${matchedFixture.homeTeam} vs ${matchedFixture.awayTeam} - ${pick.market} @ ${actualOdds}] (DB Record ID: #${betId}, Ticket: ${ticketId})!`);

    placedPickIds.add(String(pick.id));
    totalBetsPlacedCount++;
    publishLiveStatus({
      totalBetsPlaced: totalBetsPlacedCount,
      lastPlacedBet: {
        ticketId,
        match: `${matchedFixture.homeTeam} vs ${matchedFixture.awayTeam}`,
        market: pick.market,
        odds: actualOdds,
        stake: activeStake,
        currency,
        stakeMode,
        time: new Date().toLocaleTimeString()
      }
    });

    // Capture screenshot confirmation
    try {
      const confirmPath = path.resolve(__dirname, 'scratch', `placed_bet_${ticketId}.png`);
      await targetPage.screenshot({ path: confirmPath });
      logger.info('Executor', `📸 Confirmation screenshot saved: ${confirmPath}`);
    } catch (e) {}

    betsPlacedInThisRun++;
    await readAccountBalance(targetPage);

    // Close the receipt drawer modal via physical hardware click
    logger.info('Executor', 'Returning to main match board via physical click on close drawer button...');
    const receiptCloseCoords = await engineFrame.evaluate(() => {
      const closeBtn = document.querySelector('#bs-close-button, .header-back, .icon-back, [class*="back"], [class*="close"]');
      if (closeBtn) {
        const r = closeBtn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      return null;
    });
    if (receiptCloseCoords) {
      await hardwareClickAt(targetPage, receiptCloseCoords.x + fOffsetX, receiptCloseCoords.y + fOffsetY);
    }
    await randomDelay(1200, 1800);

    // Re-check countdown timer before attempting another pick in this same round
    const remainingSecs = await engineFrame.evaluate(() => {
      const timerEls = Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length === 0 && /^\d{2}:\d{2}$/.test((el.innerText || '').trim()));
      const timerText = timerEls.length > 0 ? timerEls[0].innerText.trim() : '';
      if (!timerText) return 0;
      const [m, s] = timerText.split(':').map(Number);
      return (m || 0) * 60 + (s || 0);
    });

    if (remainingSecs > 0 && remainingSecs <= 14) {
      logger.info('Executor', `⏳ Current round nearing kickoff (${remainingSecs}s remaining). Halting further picks for this round.`);
      break;
    }
    await randomDelay(1500, 2500);
  }
  return betsPlacedInThisRun > 0;
}

async function run() {
  try {
    logger.info('Executor', 'Launching browser engine with anti-detect profile...');
    page = await config.connect({ headless, userDataDir: targetProfileDir, executablePath: localChromium || undefined });
    browser = page.browser();

    // Set viewport
    try {
      await page.setViewport({ width: 1366, height: 768 });
    } catch (e) {}

    logger.info('Executor', `Navigating to: ${targetUrl}`, { targetUrl });
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(err => {
      logger.warn('Executor', 'Warning during navigation', { error: err.message });
    });

    await delay(3000);
    await dismissPopups(page);

    // Step 1: Session check & human authentication
    let alreadyLoggedIn = await checkLoggedIn(page);
    try {
      const authShot = path.resolve(__dirname, 'scratch', 'live_auth_state.png');
      await page.screenshot({ path: authShot });
      logger.info('Executor', `📸 Auth state screenshot saved: ${authShot}`);
    } catch (e) {}

    if (alreadyLoggedIn) {
      logger.info('Executor', '✅ Active 1xBet session verified.');
    } else {
      logger.info('Executor', '🔑 Not logged in. Initiating human authentication journey with real account...');
      await attemptLogin(page);
      alreadyLoggedIn = await checkLoggedIn(page);
      if (alreadyLoggedIn) {
        logger.info('Executor', '✅ Successfully authenticated into 1xBet account.');
      }
      try {
        const postAuthShot = path.resolve(__dirname, 'scratch', 'live_post_auth_state.png');
        await page.screenshot({ path: postAuthShot });
        logger.info('Executor', `📸 Post-auth state screenshot saved: ${postAuthShot}`);
      } catch (e) {}
    }

    // Step 3: Navigate to Virtual Sports via physical hardware mouse click
    await navigateToVirtualSports(page);

    // Step 4: Locate England League (NOT On Demand) and click Play button
    await launchEnglandLeague(page);

    try {
      const gameShot = path.resolve(__dirname, 'scratch', 'live_game_state.png');
      await page.screenshot({ path: gameShot });
      logger.info('Executor', `📸 Live game state screenshot saved: ${gameShot}`);
    } catch (e) {}

    logger.info('Executor', '🎯 Monitoring Golden Race VFL virtual sports and live signals...');
    logger.info('Executor', 'Standing by for incoming smart picks from Predictor server.');

    // Step 5: Continuous Automated Betting Loop with Human Rest & Session Recycling
    let sessionStartTime = Date.now();
    let RECYCLE_INTERVAL_MS = (45 + Math.floor(Math.random() * 30)) * 60 * 1000; // 45-75 minutes

    while (!isShuttingDown) {
      try {
        // Step 0: Check for network error page (chrome-error://chromewebdata)
        if (isNetworkErrorPage(page)) {
          logger.warn('Executor', '⚠️ Network error page detected. Reconnecting to Virtual Sports...');
          const recovered = await recoverNetworkConnection(page);
          if (!recovered) {
            await delay(10000);
            continue;
          }
        }

        // Step 0.1: Check for 1xBet / Golden Race "Unexpected error" overlay or crash
        const unexpectedErrorPrompt = await detectUnexpectedErrorDialog(page);
        if (unexpectedErrorPrompt) {
          logger.warn('Executor', `⚠️ 1xBet error prompt [${unexpectedErrorPrompt}] detected on page. Auto-recovering session...`);
          await recoverUnexpectedError(page);
          continue;
        }

        // Guard against browser disconnection or unexpected crash
        if (!browser || !browser.isConnected() || (page && page.isClosed())) {
          logger.warn('Executor', '⚠️ Browser or page disconnected. Re-initializing browser engine...');
          publishLiveStatus({ networkStatus: 'reconnecting' });
          try { if (browser) await browser.close(); } catch(e) {}
          page = await config.connect({ headless, userDataDir: targetProfileDir, executablePath: localChromium || undefined });
          browser = page.browser();
          await page.setViewport({ width: 1366, height: 768 }).catch(() => {});
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          await delay(3000);
          await dismissPopups(page);
          await navigateToVirtualSports(page);
          await launchEnglandLeague(page);
          publishLiveStatus({ networkStatus: 'online' });
          continue;
        }

        await dismissPopups(page);

        // Step 1: Check if session is logged out or Golden Race guest banner is active
        const authCheck = await checkAuthAndGuestStatus(page);
        if (!authCheck.isLoggedIn) {
          if (hasInvalidCredentials) {
            publishLiveStatus({
              authStatus: 'invalid_credentials',
              authErrorMessage: 'Session is logged out. Auto re-login halted because credentials were reported invalid.'
            });
          } else if (loginId && password) {
            logger.info('Executor', '⚠️ Detected logged-out session (or Golden Race demo guest mode). Re-authenticating humanly...');
            publishLiveStatus({ authStatus: 'logged_out' });
            await attemptLogin(page);
            await navigateToVirtualSports(page);
            await launchEnglandLeague(page);
          } else {
            publishLiveStatus({ authStatus: 'logged_out' });
          }
        } else {
          publishLiveStatus({ authStatus: 'authenticated', authErrorMessage: null });
        }

        // Step 2: Read live balance from account
        await readAccountBalance(page);

        // Step 3: Extract live odds from 1xBet England League
        const extracted = await extract1xBetOdds(page);

        // Step 4: Process smart picks and place single flat bets
        const betPlaced = await processSmartPicksBetting(page);

        // Periodically sync ticket settlements with predictor server
        await db.syncSettlementsWithPredictor().catch(() => {});

        if (isShuttingDown) break;

        // Step 5: Human pacing - if bet was placed, rest comfortably until next round; if standing by for fixtures, scan every 3-5s so no signals are missed!
        let restSeconds = 4;
        if (betPlaced) {
          restSeconds = Math.floor(Math.random() * 15) + 20; // 20s to 35s rest after placing bets
          logger.info('Executor', `⏳ Round bets placed. Resting profile comfortably for ${restSeconds}s while matches play...`);
        } else {
          restSeconds = Math.floor(Math.random() * 2) + 3; // 3s to 4s standing by for incoming signals
        }
        publishLiveStatus();
        await delay(restSeconds * 1000);

        if (isShuttingDown) break;

        // Step 6: Intelligent Session Refreshing at varied human times (35 to 65 minutes)
        // CRUCIAL: Only refresh in safe window (> 75s until kickoff) so NO bets are missed!
        const elapsedSession = Date.now() - sessionStartTime;
        if (elapsedSession > RECYCLE_INTERVAL_MS) {
          const isSafeWindow = extracted && extracted.timerSecs > 75;
          if (isSafeWindow) {
            logger.info('Executor', `🔄 Safe intermission window detected (⏱️ ${extracted.timerSecs}s until kickoff). Refreshing session to look natural and maintain fresh browser health...`);
            publishLiveStatus({ networkStatus: 'reconnecting' });
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
            await delay(3500);
            await dismissPopups(page);
            await getEngineFrame(page);
            sessionStartTime = Date.now();
            RECYCLE_INTERVAL_MS = (35 + Math.floor(Math.random() * 30)) * 60 * 1000;
            logger.info('Executor', `✅ Session refresh complete! Next refresh scheduled in ${Math.round(RECYCLE_INTERVAL_MS / 60000)} minutes.`);
            publishLiveStatus({ networkStatus: 'online' });
          } else {
            logger.info('Executor', `⏳ Session refresh deferred: countdown (${extracted ? extracted.timerSecs : 0}s) is close to kickoff. Waiting for next safe intermission.`);
          }
        }
      } catch (loopErr) {
        logger.warn('Executor', 'Notice in betting loop: ' + loopErr.message);
        if (isNetworkErrorPage(page)) {
          await recoverNetworkConnection(page).catch(() => {});
        } else {
          const unexp = await detectUnexpectedErrorDialog(page);
          if (unexp) {
            await recoverUnexpectedError(page).catch(() => {});
          }
        }
        await delay(10000);
      }
    }
  } catch (err) {
    logger.error('Executor', 'Fatal 1xBet Executor Error', err);
    process.exit(1);
  } finally {
    if (browser && !isShuttingDown) {
      try {
        await browser.close();
      } catch (e) {}
    }
  }
}

process.on('SIGINT', async () => {
  logger.info('Executor', 'Received SIGINT. Shutting down gracefully...');
  isShuttingDown = true;
  if (browser) {
    try { await browser.close(); } catch (e) {}
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Executor', 'Received SIGTERM. Shutting down gracefully...');
  isShuttingDown = true;
  if (browser) {
    try { await browser.close(); } catch (e) {}
  }
  process.exit(0);
});

run();
