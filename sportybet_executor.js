if (require('./utils/ensure_nigeria_vpn').ensureNigeriaVpn()) return;
const fs = require('fs');
const path = require('path');

// Auto-resolve --user-data-dir from bot_settings.json before loading config
if (!process.argv.some(a => a.startsWith('--user-data-dir='))) {
  try {
    const settingsPath = path.resolve(__dirname, 'bot_settings.json');
    if (fs.existsSync(settingsPath)) {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const family = s.sportybetExecutor?.family || s.betExecutor?.family || 'sportybet';
      const profileId = s.sportybetExecutor?.profileId || s.betExecutor?.profileId || 'profile_1793749723076';
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
const { signalCollector } = require('./utils/signal_collector');
const { SportyBetBoardHealth } = require('./utils/sportybet_board_health');
const { parseBooleanSetting } = require('./utils/executor_settings');
const { parseMyBetsText, confirmSubmission, SubmissionJournal } = require('./utils/sportybet_confirmation');
const { createHistoryReader } = require('./utils/sportybet_confirmation_ui');
const { randomUUID } = require('crypto');
const { ProviderReceiptObserver } = require('./utils/sportybet_receipts');
const receiptObservers = new WeakMap();

// Delay helpers
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => delay(min + Math.floor(Math.random() * (max - min)));

// Parse CLI Arguments
const args = process.argv.slice(2);
function getArg(name, defaultValue = null) {
  const match = args.find(a => a.startsWith(`--${name}=`));
  if (match) return match.split('=')[1];
  if (args.includes(`--${name}`)) return true;
  return defaultValue;
}

// Load Bot Settings
let botSettings = {};
try {
  const settingsPath = path.resolve(__dirname, 'bot_settings.json');
  if (fs.existsSync(settingsPath)) {
    botSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
} catch (e) {
  logger.warn('SportyBetExecutor', 'Could not read bot_settings.json', { error: e.message });
}

const executorConfig = botSettings.sportybetExecutor || botSettings.betExecutor || {};

const targetUrl = getArg('url', executorConfig.targetUrl || 'https://www.sportybet.com/ng/virtual/');
const loginId = getArg('login-id', getArg('phone', executorConfig.loginIdentifier || ''));
const password = getArg('password', executorConfig.password || '');
const headless = getArg('headless', executorConfig.headless !== undefined ? String(executorConfig.headless) : 'false') === 'true';
const currency = 'NGN';
const currencySymbol = '₦';
const defaultStake = 10;
let stakeAmount = parseFloat(getArg('stake', executorConfig.stakeAmount || defaultStake));
let stakeMode = getArg('stake-mode', executorConfig.stakeMode || 'fixed');
let stakePercentage = parseFloat(getArg('stake-percent', executorConfig.stakePercentage !== undefined ? executorConfig.stakePercentage : 2));
let startingBankroll = parseFloat(getArg('starting-bankroll', executorConfig.startingBankroll || 15000));
let stakingScaling = getArg('staking-scaling', executorConfig.stakingScaling || 'uncapped');
let autoBet = parseBooleanSetting(getArg('auto-bet', executorConfig.autoBet), true);
// Preserve an explicit launch choice until this setting actually changes on disk.
let lastConfiguredAutoBet = parseBooleanSetting(executorConfig.autoBet, true);
let requestedAutoBet = autoBet;

let stopLoss = parseFloat(getArg('stop-loss', executorConfig.stopLoss || 0));
let stopLossEnabled = getArg('stop-loss-enabled', executorConfig.stopLossEnabled !== undefined ? String(executorConfig.stopLossEnabled) : (stopLoss > 0 ? 'true' : 'false')) === 'true';

let takeProfit = parseFloat(getArg('take-profit', executorConfig.takeProfit || 0));
let takeProfitEnabled = getArg('take-profit-enabled', executorConfig.takeProfitEnabled !== undefined ? String(executorConfig.takeProfitEnabled) : (takeProfit > 0 ? 'true' : 'false')) === 'true';

let selectedTiers = (executorConfig.selectedTiers || ['safest', 'high_chance', 'high_risk']).map(t => String(t).toLowerCase());
let selectedSignalTypes = (executorConfig.selectedSignalTypes || ['all']).map(t => String(t).toLowerCase());
let selectedStrategy = getArg('selected-strategy', executorConfig.selectedStrategy || 'ai_best_pick').toLowerCase();
let minOdds = parseFloat(getArg('min-odds', executorConfig.minOdds || 0)) || 0;
let maxOdds = parseFloat(getArg('max-odds', executorConfig.maxOdds || 0)) || 0;
let minConfidence = parseFloat(getArg('min-confidence', executorConfig.minConfidence || 0)) || 0;
let teamSearch = (getArg('team-search', executorConfig.teamSearch || '')).trim().toLowerCase();

function reloadDynamicConfig() {
  try {
    const settingsPath = path.resolve(__dirname, 'bot_settings.json');
    if (!fs.existsSync(settingsPath)) return;
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const cfg = raw.sportybetExecutor || raw.betExecutor || {};

    const prevStrategy = selectedStrategy;
    const prevStakeMode = stakeMode;
    const prevStakeAmount = stakeAmount;
    const prevAutoBet = autoBet;
    const prevMinOdds = minOdds;
    const prevMaxOdds = maxOdds;
    const prevMinConf = minConfidence;
    const prevTypes = JSON.stringify(selectedSignalTypes);

    if (cfg.stakeAmount !== undefined) stakeAmount = Math.max(10, parseFloat(cfg.stakeAmount) || 10);
    if (cfg.stakeMode) stakeMode = String(cfg.stakeMode);
    if (cfg.stakePercentage !== undefined) stakePercentage = parseFloat(cfg.stakePercentage) || 2;
    if (cfg.startingBankroll !== undefined) startingBankroll = parseFloat(cfg.startingBankroll) || 15000;
    if (cfg.stakingScaling !== undefined) stakingScaling = String(cfg.stakingScaling);
    if (cfg.autoBet !== undefined) {
      const configuredAutoBet = parseBooleanSetting(cfg.autoBet, lastConfiguredAutoBet);
      if (configuredAutoBet !== lastConfiguredAutoBet) requestedAutoBet = autoBet = configuredAutoBet;
      lastConfiguredAutoBet = configuredAutoBet;
    }
    if (placementPersistenceError) autoBet = false;
    if (cfg.stopLoss !== undefined) stopLoss = parseFloat(cfg.stopLoss) || 0;
    if (cfg.stopLossEnabled !== undefined) stopLossEnabled = Boolean(cfg.stopLossEnabled);
    if (cfg.takeProfit !== undefined) takeProfit = parseFloat(cfg.takeProfit) || 0;
    if (cfg.takeProfitEnabled !== undefined) takeProfitEnabled = Boolean(cfg.takeProfitEnabled);
    if (Array.isArray(cfg.selectedTiers)) selectedTiers = cfg.selectedTiers.map(t => String(t).toLowerCase());
    if (Array.isArray(cfg.selectedSignalTypes)) selectedSignalTypes = cfg.selectedSignalTypes.map(t => String(t).toLowerCase());
    if (cfg.selectedStrategy) selectedStrategy = String(cfg.selectedStrategy).toLowerCase();
    if (cfg.minOdds !== undefined) minOdds = parseFloat(cfg.minOdds) || 0;
    if (cfg.maxOdds !== undefined) maxOdds = parseFloat(cfg.maxOdds) || 0;
    if (cfg.minConfidence !== undefined) minConfidence = parseFloat(cfg.minConfidence) || 0;
    if (cfg.teamSearch !== undefined) teamSearch = String(cfg.teamSearch || '').trim().toLowerCase();

    if (
      prevStrategy !== selectedStrategy ||
      prevStakeMode !== stakeMode ||
      prevStakeAmount !== stakeAmount ||
      prevAutoBet !== autoBet ||
      prevMinOdds !== minOdds ||
      prevMaxOdds !== maxOdds ||
      prevMinConf !== minConfidence ||
      prevTypes !== JSON.stringify(selectedSignalTypes)
    ) {
      const nextPlan = calculateCurrentStake();
      currentStake = nextPlan.stake;
      logger.info(
        'SportyBetExecutor',
        `🔄 Live UI Config Hot-Reloaded: Strategy=[${selectedStrategy.toUpperCase()}] | Staking=[${stakeMode.toUpperCase()}] | Base=[₦${stakeAmount}] | Next Stake=[₦${currentStake}] | AutoBet=[${autoBet ? 'ON' : 'OFF'}]`
      );
      publishLiveStatus({ currentStake, stakeMode, autoBetActive: autoBet });
    }
  } catch (e) {
    logger.warn('SportyBetExecutor', `Live settings reload failed; keeping current settings: ${e.message}`);
  }
}

const profileId = getArg('profile-id', getArg('profile', executorConfig.profileId || 'profile_1793749723076'));
const family = getArg('family', executorConfig.family || 'sportybet');
const targetProfileDir = (profileId && profileId !== 'temp')
  ? path.resolve(__dirname, 'profiles', family, profileId)
  : config.customConfig.userDataDir;

if (fs.existsSync(targetProfileDir)) {
  config.customConfig.userDataDir = targetProfileDir;
}

const VISION_DIR = path.resolve(__dirname, 'data', 'vision_checks');
if (!fs.existsSync(VISION_DIR)) {
  fs.mkdirSync(VISION_DIR, { recursive: true });
}

logger.info('SportyBetExecutor', '====================================================');
logger.info('SportyBetExecutor', '🚀 SPORTYBET VFL BET EXECUTOR - HUMAN AI ENGINE');
logger.info('SportyBetExecutor', `📁 Permanent Profile: [${family}] ${profileId} (${targetProfileDir})`);
logger.info('SportyBetExecutor', `💰 Base Stake: ${currencySymbol}${stakeAmount} | Strategy: ${selectedStrategy.toUpperCase()} | AutoBet: ${autoBet ? 'ON' : 'OFF'}`);

// Staking & Session State
let currentStake = Math.max(10, stakeAmount);
let initialBalance = null;
let currentBalance = null;
let sessionStartTime = Date.now();
let isShuttingDown = false;
let placementPersistenceError = null;
const submissionJournal = new SubmissionJournal(path.resolve(__dirname, 'data', 'sportybet_pending_submission.json'));
let pendingSubmission = null;
let lastReconciliationAt = 0;
let lastProviderRecoveryAt = -Infinity;
try {
  pendingSubmission = submissionJournal.pending();
  if (pendingSubmission) {
    placementPersistenceError = `Recovering submission ${pendingSubmission.id}; checking bookmaker receipts before resuming.`;
    autoBet = false;
  }
} catch (e) {
  placementPersistenceError = `Submission journal could not be read: ${e.message}. Repair the journal before resuming.`;
  autoBet = false;
}
const placedPickIds = new Set();
const confirmedSessionTickets = new Set();
const placedRoundTeams = new Set(); // Prevents duplicate bets on same match in same week
let lastSeenBoardWeek = null; // Detects season rollover (week number going backwards)
let lastPlacedWeek = null; // Strict single bet per round for Martingale; naturally cycles with rounds
let sessionStats = {
  placedCount: 0,
  wonCount: 0,
  lostCount: 0,
  totalStaked: 0,
  totalReturn: 0,
  profitLoss: 0
};

const STATUS_FILE = path.resolve(__dirname, 'data', 'executor_live_status.json');

let liveStatus = {
  running: true,
  platform: 'sportybet',
  pid: process.pid,
  updatedAt: new Date().toISOString(),
  initialBalance: null,
  currentBalance: null,
  sessionProfitLoss: 0,
  currency: 'NGN',
  stakeMode: stakeMode,
  currentStake: currentStake,
  selectedStrategy: selectedStrategy,
  betsPlaced: 0,
  totalBetsPlaced: 0,
  betsWon: 0,
  betsLost: 0,
  winRate: '0%',
  autoBetActive: autoBet,
  authStatus: 'checking',
  networkStatus: 'connecting',
  authErrorMessage: null,
  currentWeek: null,
  remainingSeconds: null,
  lastPlacedBet: null,
  recentTickets: []
};

function publishLiveStatus(updates = {}) {
  try {
    Object.assign(liveStatus, updates);
    liveStatus.autoBetActive = autoBet && !placementPersistenceError;
    if (placementPersistenceError) {
      liveStatus.autoBetActive = false;
      liveStatus.gateNotice = placementPersistenceError;
    }
    liveStatus.updatedAt = new Date().toISOString();
    liveStatus.sessionUptimeSeconds = Math.floor((Date.now() - sessionStartTime) / 1000);

    const dataDir = path.resolve(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(STATUS_FILE, JSON.stringify(liveStatus, null, 2), 'utf8');

    // Also keep data/tracker_summary.json synchronized with real-time live balance
    try {
      const summaryFile = path.resolve(__dirname, 'data', 'tracker_summary.json');
      if (fs.existsSync(summaryFile) && liveStatus.currentBalance !== null && liveStatus.currentBalance !== undefined) {
        const sumData = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
        sumData.liveBalance = liveStatus.currentBalance;
        sumData.lastUpdated = new Date().toISOString();
        if (!Array.isArray(sumData.balanceHistory)) sumData.balanceHistory = [];
        const lastEntry = sumData.balanceHistory[0];
        if (!lastEntry || Math.abs(lastEntry.balance - liveStatus.currentBalance) >= 0.5) {
          sumData.balanceHistory.unshift({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            balance: liveStatus.currentBalance,
            currency: liveStatus.currency || 'NGN',
            delta: lastEntry ? (liveStatus.currentBalance - lastEntry.balance) : 0
          });
          if (sumData.balanceHistory.length > 80) sumData.balanceHistory = sumData.balanceHistory.slice(0, 80);
        }
        fs.writeFileSync(summaryFile, JSON.stringify(sumData, null, 2), 'utf8');
      }
    } catch (err) {}
  } catch (e) {}
}

// ─── 100% Physical Hardware Mouse, Wheel & Keyboard Simulation ─────────────
let lastMouseX = 520;
let lastMouseY = 340;

function generateBezierPath(x0, y0, x1, y1, steps = 18) {
  const points = [];
  const midX = (x0 + x1) / 2 + (Math.random() - 0.5) * 90;
  const midY = (y0 + y1) / 2 + (Math.random() - 0.5) * 90;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const inv = 1 - t;
    const jitterX = (i > 0 && i < steps) ? (Math.random() - 0.5) * 2.5 : 0;
    const jitterY = (i > 0 && i < steps) ? (Math.random() - 0.5) * 2.5 : 0;
    const x = Math.round(inv * inv * x0 + 2 * inv * t * midX + t * t * x1 + jitterX);
    const y = Math.round(inv * inv * y0 + 2 * inv * t * midY + t * t * y1 + jitterY);
    points.push({ x, y });
  }
  return points;
}

async function hardwareMouseMove(targetPage, toX, toY) {
  try {
    const steps = 14 + Math.floor(Math.random() * 10);
    const path = generateBezierPath(lastMouseX, lastMouseY, toX, toY, steps);
    for (const pt of path) {
      await targetPage.mouse.move(pt.x, pt.y);
      await delay(7 + Math.floor(Math.random() * 11));
    }
    lastMouseX = toX;
    lastMouseY = toY;
  } catch (e) {}
}

async function hardwareClickAt(targetPage, x, y) {
  try {
    // Add slight human micro-offset (±1-2px) from dead center
    const targetX = Math.round(x + (Math.random() - 0.5) * 3);
    const targetY = Math.round(y + (Math.random() - 0.5) * 3);
    await hardwareMouseMove(targetPage, targetX, targetY);
    await randomDelay(110, 220);
    await targetPage.mouse.down({ button: 'left' });
    await randomDelay(65, 135);
    await targetPage.mouse.up({ button: 'left' });
    await randomDelay(160, 320);
    return true;
  } catch (e) {
    return false;
  }
}

// Low-level physical hardware mouse wheel scrolling via CDP (isTrusted = true)
async function hardwareScroll(targetPage, deltaY) {
  try {
    if (Math.abs(deltaY) < 10) return;
    // Move mouse over the center game column before wheel scrolling
    if (lastMouseX < 250 || lastMouseX > 950) {
      await hardwareMouseMove(targetPage, 560 + Math.floor(Math.random() * 60), 420 + Math.floor(Math.random() * 60));
    }
    const steps = Math.max(3, Math.floor(Math.abs(deltaY) / 85));
    const stepDelta = Math.round(deltaY / steps);
    for (let i = 0; i < steps; i++) {
      await targetPage.mouse.wheel({ deltaY: stepDelta });
      await delay(25 + Math.floor(Math.random() * 35));
    }
    await randomDelay(250, 450);
  } catch (e) {}
}

async function scrollPageToTop(targetPage) {
  try {
    const scrollY = await targetPage.evaluate(() => Math.round(window.scrollY || document.documentElement.scrollTop || 0));
    if (scrollY > 40) {
      await hardwareScroll(targetPage, -scrollY - 60);
    }
  } catch (e) {}
}

async function performHumanIdleGesture(targetPage) {
  try {
    const idleX = 380 + Math.floor(Math.random() * 420);
    const idleY = 260 + Math.floor(Math.random() * 320);
    await hardwareMouseMove(targetPage, idleX, idleY);
  } catch (e) {}
}

async function humanType(targetPage, selectorOrHandle, text) {
  try {
    let el = selectorOrHandle;
    if (typeof selectorOrHandle === 'string') {
      await targetPage.waitForSelector(selectorOrHandle, { timeout: 10000 });
      el = await targetPage.$(selectorOrHandle);
    }
    if (!el) return false;

    let box = await el.boundingBox();
    if (!box) {
      await hardwareScroll(targetPage, 200);
      await delay(300);
      box = await el.boundingBox();
    }
    if (box) {
      await hardwareClickAt(targetPage, box.x + box.width / 2, box.y + box.height / 2);
    }
    await randomDelay(120, 220);

    await targetPage.keyboard.down('Control');
    await targetPage.keyboard.press('KeyA');
    await targetPage.keyboard.up('Control');
    await targetPage.keyboard.press('Backspace');
    await randomDelay(80, 150);

    for (const ch of String(text)) {
      await targetPage.keyboard.type(ch, { delay: 45 + Math.floor(Math.random() * 55) });
    }
    await randomDelay(150, 250);
    return true;
  } catch (e) {
    return false;
  }
}

// ─── Team Aliases & Canonical Matching ─────────────────────────────────────
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
  'nottingham forest': ['for', 'nfo', 'nottm forest', 'nottingham forest', 'nottingham'],
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
  if (a === b || (a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a)))) return true;

  for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
    const canonicalNorm = normalizeTeam(canonical);
    const aliasNorms = aliases.map(normalizeTeam);
    const isA = (a === canonicalNorm || aliasNorms.includes(a));
    const isB = (b === canonicalNorm || aliasNorms.includes(b));
    if (isA && isB) return true;
  }
  return false;
}

// ─── Golden Race Frame Locator ─────────────────────────────────────────────
async function getEngineFrame(targetPage) {
  try {
    const frames = targetPage.frames();
    const engineFrame = frames.find(f => {
      if (f.isDetached()) return false;
      const u = (f.url() || '').toLowerCase();
      return u.includes('virtustec.com') || u.includes('grsleagueengland') || u.includes('golden-race');
    });
    return engineFrame || null;
  } catch (e) {
    return null;
  }
}

async function getFrameOffset(engineFrame) {
  let fOffsetX = 0, fOffsetY = 0;
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
  return { fOffsetX, fOffsetY };
}

// ─── Authentication & Balance Reading ──────────────────────────────────────
async function evaluateSportyBetAuth(targetPage) {
  return await targetPage.evaluate(() => {
    const bodyText = document.body ? document.body.innerText : '';
    const ngnMatch = bodyText.match(/NGN\s*([\d,]+(?:\.\d{2})?)/i);
    const bEl = document.querySelector('.m-balance, [class*="balance"], .m-user-balance, .header-balance');
    const bText = bEl && /\d/.test(bEl.innerText) ? bEl.innerText.trim() : (ngnMatch ? ngnMatch[0] : '');
    const hasAccount = /My\s*Account/i.test(bodyText) || /Bet\s*History/i.test(bodyText);
    const phoneInput = document.querySelector('input[name="phone"]');
    const visiblePhone = !!(phoneInput && phoneInput.offsetWidth > 10 && phoneInput.offsetHeight > 10);
    return {
      isLoggedIn: !!(bText && (hasAccount || !visiblePhone)),
      balanceText: bText,
      visiblePhone
    };
  }).catch(() => ({ isLoggedIn: false, balanceText: '', visiblePhone: false }));
}

async function readSportyBetBalance(targetPage, engineFrame = null) {
  try {
    const authInfo = await evaluateSportyBetAuth(targetPage);
    if (authInfo.balanceText && /\d/.test(authInfo.balanceText)) {
      parseAndUpdateBalance(authInfo.balanceText);
      return currentBalance;
    }
    if (engineFrame && !engineFrame.isDetached()) {
      const frameBal = await engineFrame.evaluate(() => {
        const all = Array.from(document.querySelectorAll('*'));
        const cred = all.find(el => el.children.length === 0 && /CREDIT\s*₦?[\d,]+/i.test((el.innerText || '').trim()));
        return cred ? cred.innerText.trim() : '';
      });
      if (frameBal) {
        parseAndUpdateBalance(frameBal);
      }
    }
  } catch (e) {}
  return currentBalance;
}

async function checkAndEnsureAuth(targetPage) {
  logger.info('SportyBetExecutor', '🔍 Checking SportyBet authentication status...');
  publishLiveStatus({ authStatus: 'checking' });

  try {
    let authInfo = await evaluateSportyBetAuth(targetPage);

    if (authInfo.isLoggedIn) {
      parseAndUpdateBalance(authInfo.balanceText);
      publishLiveStatus({ authStatus: 'authenticated', authErrorMessage: null });
      logger.info('SportyBetExecutor', `✅ Authenticated via Permanent Profile! Live SportyBet Balance: ${currencySymbol}${currentBalance}`);
      return true;
    }

    // Check if we haven't loaded SportyBet yet
    if (!targetPage.url().includes('sportybet.com')) {
      logger.info('SportyBetExecutor', '🌐 Opening SportyBet Nigeria...');
      await targetPage.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await randomDelay(3500, 4500);

      authInfo = await evaluateSportyBetAuth(targetPage);

      if (authInfo.isLoggedIn) {
        parseAndUpdateBalance(authInfo.balanceText);
        publishLiveStatus({ authStatus: 'authenticated', authErrorMessage: null });
        logger.info('SportyBetExecutor', `✅ Permanent Profile Session Restored! Balance: ${currencySymbol}${currentBalance}`);
        return true;
      }
    }

    // Attempt automatic human login
    logger.info('SportyBetExecutor', '🔑 Session logged out. Performing human login to SportyBet...');
    publishLiveStatus({ authStatus: 'logging_in' });

    if (!targetPage.url().includes('sportybet.com')) {
      await targetPage.goto('https://www.sportybet.com/ng/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await delay(3500);
    }

    await scrollPageToTop(targetPage);

    // Dismiss popups via physical hardware clicks
    const closeBtns = await targetPage.$$('.es-dialog-close, .dialog-close, .m-dialog-close');
    for (const btn of closeBtns) {
      try {
        const box = await btn.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          await hardwareClickAt(targetPage, box.x + box.width / 2, box.y + box.height / 2);
          await delay(350);
        }
      } catch (e) {}
    }

    const cleanPhone = loginId.startsWith('0') ? loginId.slice(1) : loginId;
    await humanType(targetPage, 'input[name="phone"]', cleanPhone);
    await randomDelay(250, 450);

    await humanType(targetPage, 'input[name="psd"]', password);
    await randomDelay(250, 450);

    // Keep signed in checkbox via physical hardware click
    const keepBtn = await targetPage.$('input[name="keepSignedIn"]');
    if (keepBtn) {
      const isChecked = await targetPage.evaluate(el => el.checked, keepBtn);
      if (!isChecked) {
        const box = await keepBtn.boundingBox();
        if (box) {
          await hardwareClickAt(targetPage, box.x + box.width / 2, box.y + box.height / 2);
          await randomDelay(180, 320);
        }
      }
    }

    const loginBtn = await targetPage.$('button.m-btn-login, button[type="submit"]');
    if (loginBtn) {
      const b = await loginBtn.boundingBox();
      if (b) await hardwareClickAt(targetPage, b.x + b.width / 2, b.y + b.height / 2);
    }

    logger.info('SportyBetExecutor', '⏳ Waiting for login confirmation...');
    await delay(6000);

    const postAuth = await targetPage.evaluate(() => {
      const bEl = document.querySelector('.m-balance, [class*="balance"], .m-user-balance');
      const err = document.querySelector('.m-error, .m-msg-error, .af-toast--error');
      const txt = bEl ? bEl.innerText.trim() : '';
      return {
        isLoggedIn: !!bEl && /\d/.test(txt),
        balanceText: txt,
        error: err ? err.innerText.trim() : null
      };
    });

    if (postAuth.isLoggedIn) {
      parseAndUpdateBalance(postAuth.balanceText);
      publishLiveStatus({ authStatus: 'authenticated', authErrorMessage: null });
      logger.info('SportyBetExecutor', `🎉 Human Login Successful! Balance: ${currencySymbol}${currentBalance}`);
      return true;
    } else {
      const msg = postAuth.error || 'Login verification pending';
      logger.warn('SportyBetExecutor', `⚠️ ${msg}`);
      publishLiveStatus({ authStatus: 'error', authErrorMessage: msg });
      return false;
    }
  } catch (err) {
    logger.error('SportyBetExecutor', `Authentication error: ${err.message}`);
    publishLiveStatus({ authStatus: 'error', authErrorMessage: err.message });
    return false;
  }
}

function parseAndUpdateBalance(balanceStr) {
  if (!balanceStr) return;
  const cleaned = balanceStr.replace(/CREDIT/i, '').replace(/NGN/i, '').replace(/₦/g, '').replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  if (!isNaN(num) && num >= 0) {
    if (initialBalance === null) initialBalance = num;
    currentBalance = num;
    const pnl = currentBalance - initialBalance;
    sessionStats.profitLoss = pnl;
    publishLiveStatus({
      initialBalance,
      currentBalance,
      sessionProfitLoss: Math.round(pnl * 100) / 100
    });
  }
}

// ─── Golden Race England League Navigator ──────────────────────────────────
async function navigateToEnglandLeague(targetPage) {
  logger.info('SportyBetExecutor', '⚽ Navigating to SportyBet Scheduled Virtuals...');
  publishLiveStatus({ networkStatus: 'navigating' });

  try {
    if (!targetPage.url().includes('/virtual')) {
      // Try clicking the "Scheduled Virtuals" nav tab physically first like a human
      const virtualNavCoords = await targetPage.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, nav *, header *'));
        const vLink = links.find(el => /scheduled\s*virtuals/i.test((el.innerText || '').trim()) && el.offsetWidth > 20);
        if (vLink) {
          const r = vLink.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        return null;
      });

      if (virtualNavCoords) {
        logger.info('SportyBetExecutor', `🖱️ Physically clicking "Scheduled Virtuals" tab at (${virtualNavCoords.x}, ${virtualNavCoords.y})...`);
        await hardwareClickAt(targetPage, virtualNavCoords.x, virtualNavCoords.y);
        await delay(5000);
      } else {
        await targetPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await delay(4500);
      }
    }

    // Wait for engine frame
    logger.info('SportyBetExecutor', '⏳ Waiting for Golden Race engine frame to initialize...');
    let engineFrame = null;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 35000) {
      await delay(1500);
      engineFrame = await getEngineFrame(targetPage);
      if (engineFrame) break;
    }

    if (!engineFrame) {
      logger.warn('SportyBetExecutor', '⚠️ Frame not mounted. Reloading virtuals page...');
      await targetPage.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      await delay(5000);
      engineFrame = await getEngineFrame(targetPage);
    }

    if (!engineFrame) {
      logger.error('SportyBetExecutor', '❌ Could not mount Golden Race engine frame.');
      return null;
    }

    logger.info('SportyBetExecutor', '✅ Golden Race engine frame ready! Selecting Football League -> England...');
    await delay(2000);

    // 1. Direct Angular hash routing to playlist 41104 (England League)
    await engineFrame.evaluate(() => {
      try {
        const targetHash = '#/scheduled/league/playlist/41104';
        if (!window.location.hash.includes('playlist/41104')) {
          window.location.hash = targetHash;
        }
      } catch (e) {}
    });
    await delay(3000);

    await scrollPageToTop(targetPage);
    const { fOffsetX, fOffsetY } = await getFrameOffset(engineFrame);

    // 2. Expand Football League if collapsed
    const flCoords = await engineFrame.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('a, li, span, div'));
      const toggler = allEls.find(el => {
        const t = (el.innerText || '').trim();
        return /football\s*league/i.test(t) && el.offsetWidth > 15;
      });
      if (toggler) {
        const isCollapsed = toggler.classList.contains('collapsed') || 
                            (toggler.className || '').toString().includes('collapsed') || 
                            !!toggler.querySelector('.gr-icon-arrow-right, [class*="arrow-right"]');
        const r = toggler.getBoundingClientRect();
        return { isCollapsed, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      return null;
    });

    if (flCoords && flCoords.isCollapsed) {
      await hardwareClickAt(targetPage, flCoords.x + fOffsetX, flCoords.y + fOffsetY);
      await randomDelay(1500, 2500);
    }

    // 3. Click England sub-item
    const engCoords = await engineFrame.evaluate(() => {
      const allA = Array.from(document.querySelectorAll('a, span, div'));
      const eng = allA.find(a => {
        const t = (a.innerText || '').trim().toLowerCase();
        return (t === 'england' || a.getAttribute('title') === 'England') && a.offsetWidth > 15;
      });
      if (eng) {
        const r = eng.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      return null;
    });

    if (engCoords) {
      await hardwareClickAt(targetPage, engCoords.x + fOffsetX, engCoords.y + fOffsetY);
      await delay(4500);
    }

    // Save vision check screenshot of loaded England League board
    try {
      await targetPage.screenshot({ path: path.join(VISION_DIR, 'latest_board.png') });
    } catch (e) {}

    logger.info('SportyBetExecutor', 'England League selected. Waiting for a readable, updating match board...');
    publishLiveStatus({ networkStatus: 'reconnecting', boardStatus: 'waiting' });
    return engineFrame;
  } catch (err) {
    logger.error('SportyBetExecutor', `Error navigating to England League: ${err.message}`);
    return null;
  }
}

// ─── Extract Upcoming Board State (Timer, Week, 10 Upcoming Fixtures) ──────
async function extractBoardState(engineFrame) {
  try {
    return await engineFrame.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));

      // 1. Locate "Market filter" y-coordinate so we only read the UPCOMING odds table below it
      let marketFilterY = 320;
      const mfEl = all.find(el => el.children.length === 0 && /market\s*filter/i.test((el.innerText || '').trim()));
      if (mfEl) {
        marketFilterY = Math.round(mfEl.getBoundingClientRect().bottom);
      }

      // 2. Parse Countdown Timer & Upcoming Week from the green bar ("01:45 Football League: England Week 5") or circular timer
      let remainingSec = null;
      let weekNumber = null;
      let timerText = '';

      for (const el of all) {
        const txt = (el.innerText || '').trim();
        if (!txt) continue;

        const barMatch = txt.match(/(\d{2}):(\d{2})\s*Football League:\s*England\s*Week\s*(\d+)/i);
        if (barMatch) {
          remainingSec = parseInt(barMatch[1], 10) * 60 + parseInt(barMatch[2], 10);
          timerText = `${barMatch[1]}:${barMatch[2]}`;
          weekNumber = parseInt(barMatch[3], 10);
          break;
        }
      }

      // Fallback timer & week detection
      if (remainingSec === null) {
        for (const el of all) {
          if (el.children.length === 0) {
            const txt = (el.innerText || '').trim();
            const r = el.getBoundingClientRect();
            if (r.top > 80 && /^0[0-3]:\d{2}$/.test(txt)) {
              const [m, s] = txt.split(':').map(Number);
              remainingSec = m * 60 + s;
              timerText = txt;
              break;
            }
          }
        }
      }

      // Check active week selector tab (e.g. "Week 37")
      if (weekNumber === null) {
        const weekTabs = all.filter(el => {
          const t = (el.innerText || '').trim();
          return /^Week\s*(\d+)$/i.test(t) && el.offsetWidth > 15;
        });
        const activeTab = weekTabs.find(el => el.classList.contains('active') || el.classList.contains('selected') || (el.className || '').includes('active'));
        const targetTab = activeTab || weekTabs[0];
        if (targetTab) {
          const m = (targetTab.innerText || '').trim().match(/^Week\s*(\d+)$/i);
          if (m) weekNumber = parseInt(m[1], 10);
        }
      }

      // 3. Extract 3-letter team codes strictly from the UPCOMING betting table (below Market filter, left side)
      const teamBadges = all
        .filter(el => {
          if (el.children.length !== 0) return false;
          const t = (el.innerText || '').trim();
          if (!/^[A-Z]{3}$/.test(t)) return false;
          const r = el.getBoundingClientRect();
          return r.top > marketFilterY && r.left < 460 && r.width > 10;
        })
        .map(el => {
          const r = el.getBoundingClientRect();
          return {
            code: el.innerText.trim(),
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2)
          };
        });

      // Group by row (same y within 12px), sorted top to bottom, then left to right
      teamBadges.sort((a, b) => (Math.abs(a.y - b.y) > 12 ? a.y - b.y : a.x - b.x));

      const fixtures = [];
      const activeBadges = teamBadges.slice(0, 20);
      for (let i = 0; i < activeBadges.length - 1; i += 2) {
        const home = activeBadges[i];
        const away = activeBadges[i + 1];
        if (Math.abs(home.y - away.y) <= 15) {
          fixtures.push({
            rowIndex: fixtures.length + 1,
            homeCode: home.code,
            awayCode: away.code,
            rowY: Math.round((home.y + away.y) / 2)
          });
        }
      }

      return {
        remainingSec,
        timerText,
        weekNumber,
        marketFilterY,
        fixtures
      };
    });
  } catch (e) {
    return { remainingSec: null, timerText: '', weekNumber: null, marketFilterY: 320, fixtures: [], extractionError: e.message };
  }
}

async function recoverStalledBoard(targetPage, reason) {
  logger.warn('SportyBetExecutor', `Board recovery: ${reason}. Reloading SportyBet virtuals...`);
  publishLiveStatus({ networkStatus: 'reconnecting', boardStatus: 'recovering', boardError: reason });
  try {
    await targetPage.screenshot({ path: path.join(VISION_DIR, 'stalled_board.png') }).catch(() => {});
    // Re-selecting England in the same iframe does not restart a frozen provider connection.
    await targetPage.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await delay(5000);
    const auth = await evaluateSportyBetAuth(targetPage);
    if (!auth.isLoggedIn && auth.visiblePhone) {
      const authed = await checkAndEnsureAuth(targetPage);
      if (!authed) throw new Error('Authentication is still pending after reload');
    }
    const frame = await navigateToEnglandLeague(targetPage);
    if (!frame) throw new Error('Golden Race frame unavailable after reload');
    return frame;
  } catch (err) {
    logger.warn('SportyBetExecutor', `Board recovery incomplete: ${err.message}. Will retry after cooldown.`);
    publishLiveStatus({ networkStatus: 'degraded', boardStatus: 'stalled', boardError: err.message });
    return null;
  }
}

// ─── Market Navigation & Odds Selection ────────────────────────────────────
async function selectMarketFilter(engineFrame, targetPage, marketStr) {
  const normMarket = (marketStr || '').toLowerCase().trim();
  await scrollPageToTop(targetPage);
  const { fOffsetX, fOffsetY } = await getFrameOffset(engineFrame);

  try {
    let mainTabName = 'MAIN';
    let subMarketName = 'Match result';

    if (normMarket.includes('double') || normMarket.includes('dc') || normMarket === '1x' || normMarket === '12' || normMarket === 'x2') {
      mainTabName = 'MAIN';
      subMarketName = 'Double Chance';
    } else if (normMarket.includes('over') || normMarket.includes('under') || normMarket.includes('o/u') || normMarket.includes('ov ') || normMarket.includes('un ')) {
      mainTabName = 'Over/Under';
      subMarketName = null;
    } else if (normMarket.includes('gg') || normMarket.includes('ng') || normMarket.includes('both teams') || normMarket.includes('btts') || normMarket.includes('goal goal') || normMarket.includes('no goal')) {
      mainTabName = 'Others';
      subMarketName = 'Goal Goal/No Goal';
    } else if (normMarket.includes('ht/ft') || normMarket.includes('ht-ft') || normMarket.includes('half') || /^[1x2]\/[1x2]$/i.test(normMarket)) {
      mainTabName = 'Others';
      subMarketName = 'Half Time/Full Time';
    } else if (normMarket.includes('correct') || normMarket.includes('cs') || /^\d+[-:]\d+$/.test(normMarket)) {
      mainTabName = 'Correct Score';
      subMarketName = null;
    } else {
      mainTabName = 'MAIN';
      subMarketName = 'Match result';
    }

    logger.info('SportyBetExecutor', `📑 Switching market filter to: [${mainTabName}${subMarketName ? ' -> ' + subMarketName : ''}]...`);

    // Click Main Tab physically
    const mainTabCoords = await engineFrame.evaluate((tabName) => {
      const candidates = Array.from(document.querySelectorAll('*'));
      const target = candidates.find(el => {
        const t = (el.innerText || '').trim();
        return t.toLowerCase() === tabName.toLowerCase() && el.children.length === 0 && el.offsetWidth > 30;
      });
      if (target) {
        const r = target.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      return null;
    }, mainTabName);

    if (mainTabCoords) {
      await hardwareClickAt(targetPage, mainTabCoords.x + fOffsetX, mainTabCoords.y + fOffsetY);
      await randomDelay(750, 1250);
    }

    // Click Sub Market Tab if applicable
    if (subMarketName) {
      const subCoords = await engineFrame.evaluate((subName) => {
        const candidates = Array.from(document.querySelectorAll('*'));
        const target = candidates.find(el => {
          const t = (el.innerText || '').trim();
          return t.toLowerCase() === subName.toLowerCase() && el.children.length === 0 && el.offsetWidth > 30;
        });
        if (target) {
          const r = target.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        return null;
      }, subMarketName);

      if (subCoords) {
        await hardwareClickAt(targetPage, subCoords.x + fOffsetX, subCoords.y + fOffsetY);
        await randomDelay(750, 1250);
      }
    }

    return true;
  } catch (e) {
    logger.warn('SportyBetExecutor', `Market filter selection notice: ${e.message}`);
    return false;
  }
}

// ─── Clear Betslip Helper (Physical Click) ─────────────────────────────────
async function clearBetslipPhysically(engineFrame, targetPage) {
  await scrollPageToTop(targetPage);
  const { fOffsetX, fOffsetY } = await getFrameOffset(engineFrame);

  const clearCoords = await engineFrame.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'));
    const expired = all.find(el => el.children.length === 0 && /clear\s*expired/i.test((el.innerText || '').trim()));
    if (expired) {
      const r = expired.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: 'Clear Expired' };
    }
    const clearAll = all.find(el => el.children.length === 0 && /^clear\s*all/i.test((el.innerText || '').trim()));
    if (clearAll) {
      const r = clearAll.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: 'Clear All' };
    }
    return null;
  });

  if (clearCoords) {
    logger.info('SportyBetExecutor', `🧹 Physically clicking "${clearCoords.label}" at (${clearCoords.x + fOffsetX}, ${clearCoords.y + fOffsetY})...`);
    await hardwareClickAt(targetPage, clearCoords.x + fOffsetX, clearCoords.y + fOffsetY);
    await randomDelay(500, 900);
  }
}

// ─── Clear Completed Tickets Helper (Physical Click at 100 Completed Bets) ──
async function clearCompletedTicketsPhysically(engineFrame, targetPage) {
  if (!engineFrame || engineFrame.isDetached()) return false;
  try {
    await scrollPageToTop(targetPage);
    const { fOffsetX, fOffsetY } = await getFrameOffset(engineFrame);

    // 1. Check if "Clear Completed" is directly visible
    let clearBtn = await engineFrame.evaluate(() => {
      const all = Array.from(document.querySelectorAll("*"));
      const btn = all.find(el => {
        const t = (el.innerText || "").trim();
        return (el.children.length <= 1) && /clear\s*completed/i.test(t) && el.offsetWidth > 15 && el.offsetWidth < 260;
      });
      if (btn) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: (btn.innerText || "").trim().slice(0, 30) };
        }
      }
      return null;
    });

    // 2. If not directly visible, click "My Bets" tab to bring completed tickets into view
    if (!clearBtn) {
      const myBetsTab = await engineFrame.evaluate(() => {
        const all = Array.from(document.querySelectorAll("a, button, div, span, li"));
        const tab = all.find(el => {
          const t = (el.innerText || "").trim();
          return /my\s*bets/i.test(t) && !/betslip/i.test(t) && el.offsetWidth > 15 && el.offsetWidth < 200;
        });
        if (tab) {
          const r = tab.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
        }
        return null;
      });

      if (myBetsTab) {
        logger.info("SportyBetExecutor", `📑 Switching to "My Bets" tab at (${myBetsTab.x + fOffsetX}, ${myBetsTab.y + fOffsetY})...`);
        await hardwareClickAt(targetPage, myBetsTab.x + fOffsetX, myBetsTab.y + fOffsetY);
        await randomDelay(800, 1400);

        // Search again for "Clear Completed" button
        clearBtn = await engineFrame.evaluate(() => {
          const all = Array.from(document.querySelectorAll("*"));
          const btn = all.find(el => {
            const t = (el.innerText || "").trim();
            return (el.children.length <= 1) && /clear\s*completed/i.test(t) && el.offsetWidth > 15 && el.offsetWidth < 260;
          });
          if (btn) {
            const r = btn.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: (btn.innerText || "").trim().slice(0, 30) };
            }
          }
          return null;
        });
      }
    }

    if (clearBtn) {
      const clickX = clearBtn.x + fOffsetX;
      const clickY = clearBtn.y + fOffsetY;
      logger.info("SportyBetExecutor", `🗑️ Executing physical click on "${clearBtn.label}" at (${clickX}, ${clickY})...`);
      await hardwareClickAt(targetPage, clickX, clickY);
      await randomDelay(1000, 1800);

      // 3. Switch back to "Betslip" tab so subsequent bet placement is ready
      const betslipTab = await engineFrame.evaluate(() => {
        const all = Array.from(document.querySelectorAll("a, button, div, span, li"));
        const tab = all.find(el => {
          const t = (el.innerText || "").trim();
          return /^betslip/i.test(t) && !/my\s*bets/i.test(t) && el.offsetWidth > 15 && el.offsetWidth < 200;
        });
        if (tab) {
          const r = tab.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
        }
        return null;
      });

      if (betslipTab) {
        await hardwareClickAt(targetPage, betslipTab.x + fOffsetX, betslipTab.y + fOffsetY);
        await randomDelay(500, 900);
      }
      return true;
    } else {
      logger.info("SportyBetExecutor", "ℹ️ 'Clear Completed' button not found or no completed tickets to clear.");
      // Ensure we switch back to Betslip tab
      const betslipTab = await engineFrame.evaluate(() => {
        const all = Array.from(document.querySelectorAll("a, button, div, span, li"));
        const tab = all.find(el => {
          const t = (el.innerText || "").trim();
          return /^betslip/i.test(t) && el.offsetWidth > 15;
        });
        if (tab) {
          const r = tab.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
        }
        return null;
      });
      if (betslipTab) {
        await hardwareClickAt(targetPage, betslipTab.x + fOffsetX, betslipTab.y + fOffsetY);
        await randomDelay(400, 800);
      }
    }
  } catch (err) {
    logger.warn("SportyBetExecutor", `Clear Completed error: ${err.message}`);
  }
  return false;
}

// ─── Betslip & My Bets Tab Switchers (100% Physical Human Hardware Clicks) ──
async function switchToMyBetsTab(engineFrame, targetPage) {
  if (!engineFrame || engineFrame.isDetached()) return false;
  try {
    const { fOffsetX, fOffsetY } = await getFrameOffset(engineFrame);
    const myBetsTab = await engineFrame.evaluate(() => {
      const all = Array.from(document.querySelectorAll("a, button, div, span, li"));
      const tab = all.filter(el => {
        const t = (el.innerText || "").trim();
        return /^my\s*bets(?:\s*\d+)?$/i.test(t) && el.offsetWidth > 15 && el.offsetWidth < 240 && el.offsetHeight < 70;
      }).sort((a, b) => a.offsetWidth * a.offsetHeight - b.offsetWidth * b.offsetHeight)[0];
      if (tab) {
        const r = tab.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    });
    if (myBetsTab) {
      await hardwareClickAt(targetPage, myBetsTab.x + fOffsetX, myBetsTab.y + fOffsetY);
      await randomDelay(500, 800);
      return true;
    }
  } catch (e) {}
  return false;
}

async function switchToBetslipTab(engineFrame, targetPage) {
  if (!engineFrame || engineFrame.isDetached()) return false;
  try {
    const { fOffsetX, fOffsetY } = await getFrameOffset(engineFrame);
    const betslipTab = await engineFrame.evaluate(() => {
      const all = Array.from(document.querySelectorAll("a, button, div, span, li"));
      const tab = all.filter(el => {
        const t = (el.innerText || "").trim();
        return /^betslip(?:\s*\d+)?$/i.test(t) && el.offsetWidth > 15 && el.offsetWidth < 240 && el.offsetHeight < 70;
      }).sort((a, b) => a.offsetWidth * a.offsetHeight - b.offsetWidth * b.offsetHeight)[0];
      if (tab) {
        const r = tab.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    });
    if (betslipTab) {
      await hardwareClickAt(targetPage, betslipTab.x + fOffsetX, betslipTab.y + fOffsetY);
      await randomDelay(500, 800);
      return true;
    }
  } catch (e) {}
  return false;
}

// ─── Read Confirmed Tickets from My Bets Section (Read-Only Evaluation) ───
async function readMyBetsTickets(engineFrame) {
  if (!engineFrame || engineFrame.isDetached()) return [];
  const text = await engineFrame.evaluate(() => document.body ? document.body.innerText : '');
  return parseMyBetsText(text);
}

// ─── Verify Pick Presence in Betslip (Read-Only Evaluation) ───────────────
function matchesBetslipMarket(text, pick) {
  const wanted = `${pick.market || ''} ${pick.selection || ''}`.toLowerCase();
  const actual = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  const htft = wanted.match(/([1x2])\s*\/\s*([1x2])/i);
  if (htft) {
    const names = { '1': 'home', x: 'draw', '2': 'away' };
    return new RegExp(`\\b(?:${htft[1]}\\s*/\\s*${htft[2]}|${names[htft[1]]}\\s*/\\s*${names[htft[2]]})\\b`, 'i').test(actual);
  }
  const goals = wanted.match(/\b(over|under|ov|un)\s*(\d+(?:\.\d+)?)/);
  if (goals) {
    const side = /^(over|ov)$/.test(goals[1]) ? '(?:over|ov)' : '(?:under|un)';
    return new RegExp(`\\b${side}\\s*${goals[2].replace('.', '\\.')}\\b`, 'i').test(actual);
  }
  const dc = wanted.match(/\b(1x|x2|12)\b/);
  if (dc) {
    const labels = { '1x': 'home\\s*(?:or|/)\\s*draw', x2: 'draw\\s*(?:or|/)\\s*away', '12': 'home\\s*(?:or|/)\\s*away' };
    return /double\s*chance/.test(actual) && new RegExp(`\\b(?:${dc[1]}|${labels[dc[1]]})\\b`, 'i').test(actual);
  }
  if (/both teams|btts|goal goal|no goal|\bgg\b|\bng\b/.test(wanted)) {
    const no = /btts\s*no|both teams.*\bno\b|no goal|\bng\b/.test(wanted);
    const selection = actual.replace(/goal\s*goal\s*\/\s*no\s*goal|both\s*teams\s*to\s*score/g, '');
    return no ? /\b(?:ng|no|no goal)\b/.test(selection) : /\b(?:gg|yes|goal goal)\b/.test(selection);
  }
  const result = wanted.match(/\b(home|away|draw)\b/)?.[1] || ({ '1': 'home', x: 'draw', '2': 'away' })[String(pick.selection || pick.market || '').trim().toLowerCase()];
  return !!result && /match\s*result/.test(actual) && new RegExp(`\\b${result}\\b`).test(actual);
}

async function verifyBetslipContainsPick(engineFrame, pick) {
  if (!engineFrame || engineFrame.isDetached()) return { ok: false, reason: 'frame_detached' };
  try {
    const slip = await engineFrame.evaluate(() => {
      const betslip = document.querySelector('.betslip, [class*="betslip"], app-betslip');
      if (!betslip) return null;
      const bsText = (betslip.innerText || '').replace(/\s+/g, ' ');
      const inputs = Array.from(betslip.querySelectorAll('input'));
      const hasInput = inputs.some(i => i.offsetWidth > 15);
      const fixture = bsText.match(/\b([A-Z]{3})\s*-\s*([A-Z]{3})\b/);
      const fixtureId = bsText.match(/#(\d{6,7})\b/)?.[1] || null;
      const week = bsText.match(/\bWeek\s*(\d+)\b/i);
      const countMatch = bsText.match(/Clear All\s*\((\d+)\)/i);
      return {
        hasInput, count: countMatch ? Number(countMatch[1]) : 0,
        fixtureId, homeCode: fixture?.[1], awayCode: fixture?.[2], week: week ? Number(week[1]) : null,
        marketText: bsText.match(/\bWeek\s*\d+\s*([\s\S]*?)(?:Stake\s*mode|Single\s*\(|Total\s*stake|$)/i)?.[1] || '',
        bsPreview: bsText.slice(0, 200)
      };
    });
    if (!slip || !slip.hasInput || slip.count !== 1) return { ok: false, reason: 'betslip_not_single', ...slip };
    if (!matchTeams(pick.home_team, slip.homeCode) || !matchTeams(pick.away_team, slip.awayCode)) return { ...slip, ok: false, reason: 'betslip_fixture_mismatch' };
    if (pick.round_number == null || slip.week !== Number(pick.round_number)) return { ...slip, ok: false, reason: 'betslip_week_mismatch' };
    if (!matchesBetslipMarket(slip.marketText, pick)) return { ...slip, ok: false, reason: 'betslip_market_mismatch' };
    return { ...slip, ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─── Confirm Placed Bet in My Bets Section (100% Physical Hardware Tab Switch) ──
async function createConfirmationIO(engineFrame, targetPage) {
  if (!receiptObservers.has(engineFrame)) {
    receiptObservers.set(engineFrame, Promise.resolve().then(() => new ProviderReceiptObserver(engineFrame._client()).start()).catch(e => {
      logger.warn('SportyBetExecutor', `Provider receipt observer unavailable; using visible receipts and history: ${e.message}`);
      return null;
    }));
  }
  const observer = await receiptObservers.get(engineFrame);
  if (observer && observer.client !== engineFrame._client()) {
    observer.stop();
    receiptObservers.delete(engineFrame);
    return createConfirmationIO(engineFrame, targetPage);
  }
  return {
    matchTeams, matchesMarket: matchesBetslipMarket,
    readReceipts: async () => observer?.receipts || [],
    providerAuthExpired: () => !!observer?.authExpired,
    openMyBets: async () => {
      if (!await switchToMyBetsTab(engineFrame, targetPage)) throw new Error('My Bets tab could not be opened');
    },
    readMyBets: () => readMyBetsTickets(engineFrame),
    readHistory: createHistoryReader({ frame: engineFrame, page: targetPage, observer, getFrameOffset, hardwareClickAt, hardwareScroll, hardwareMouseMove, delay }),
    readRejection: () => engineFrame.evaluate(() => {
      const text = document.body?.innerText || '';
      if (/insufficient\s*(?:balance|funds)/i.test(text)) return 'insufficient_funds';
      if (/odds?\s*(?:have\s*)?changed/i.test(text)) return 'odds_changed';
      if (/selection\s*(?:is\s*)?expired/i.test(text)) return 'selection_expired';
      if (/ticket\s*(?:was\s*)?rejected|bet\s*(?:was\s*)?not\s*accepted/i.test(text)) return 'bookmaker_rejected';
      return null;
    })
  };
}

async function confirmBetPlacementInMyBets(engineFrame, targetPage, pick, expectedStake, timeoutMs = 30000, submission = pendingSubmission) {
  if (!submission) return { confirmed: false, reason: 'submission_context_missing' };
  return confirmSubmission(submission, await createConfirmationIO(engineFrame, targetPage), { timeoutMs });
}

function pauseSubmission(reason) {
  placementPersistenceError = reason;
  autoBet = false;
  publishLiveStatus({ placementStatus: 'placement_paused', gateNotice: reason,
    pendingSubmissionId: pendingSubmission?.id || null, confirmationStatus: 'reconciling' });
}

function recordConfirmedSubmission(submission, confirmation) {
  // Save the receipt before the database write, so a crash can retry persistence without a new wager.
  pendingSubmission = submissionJournal.save({ ...submission, state: 'pending', confirmation });
  const pick = submission.pick;
  const status = ['WON', 'LOST', 'VOID', 'CANCELLED'].includes(confirmation.status) ? (confirmation.status === 'CANCELLED' ? 'VOID' : confirmation.status) : 'PENDING';
  const settlementAlreadyCounted = settledTicketTracker.get(String(confirmation.ticketId)) === status;
  const id = db.recordPlacedBet({ signal_id: String(pick.id), season_name: pick.season_name || 'SportyBet Golden Race VFL England League',
    week: String(pick.round_number), round: String(pick.round_number), kickoff_time: pick.match_time || '',
    home_team: pick.home_team, away_team: pick.away_team, market: pick.market, selection: pick.selection || pick.market,
    odds: submission.odds, stake: submission.stake, currency: 'NGN', status, ticket_id: String(confirmation.ticketId), placed_at: submission.submittedAt });
  if (!id) throw new Error(`Ticket #${confirmation.ticketId} could not be persisted`);
  if (status !== 'PENDING') {
    const payout = Number.isFinite(confirmation.won) ? confirmation.won : submission.stake * submission.odds;
    const pnl = status === 'LOST' ? -submission.stake : status === 'VOID' ? 0 : payout - submission.stake;
    if (!db.updateBetSettlement(String(confirmation.ticketId), status, pnl)) throw new Error('Confirmed ticket settlement could not be persisted');
    settledTicketTracker.set(String(confirmation.ticketId), status);
  }
  submissionJournal.save({ ...submission, state: 'confirmed', confirmation });
  pendingSubmission = null;
  placementPersistenceError = null;
  autoBet = requestedAutoBet;
  placedPickIds.add(String(pick.id));
  if (Number(liveStatus.currentWeek) === Number(pick.round_number) && Date.now() - Date.parse(submission.submittedAt) < 300000) {
    if (pick._matchKey) placedRoundTeams.add(pick._matchKey);
    lastPlacedWeek = Number(pick.round_number);
  }
  if (!confirmedSessionTickets.has(String(confirmation.ticketId))) {
    confirmedSessionTickets.add(String(confirmation.ticketId));
    sessionStats.placedCount++;
    sessionStats.totalStaked += submission.stake;
    if (status === 'WON' && !settlementAlreadyCounted) sessionStats.wonCount++;
    if (status === 'LOST' && !settlementAlreadyCounted) sessionStats.lostCount++;
  }
  const betSummary = { ticketId: String(confirmation.ticketId), match: `${pick.home_team} vs ${pick.away_team}`,
    market: pick.market, odds: submission.odds, stake: submission.stake, status,
    probability: pick.probability ? `${Number(pick.probability).toFixed(1)}%` : null, tier: pick.pick_type || 'ai_best',
    time: new Date(submission.submittedAt).toLocaleTimeString(), confirmationSource: confirmation.source };
  publishLiveStatus({ betsPlaced: sessionStats.placedCount, totalBetsPlaced: sessionStats.placedCount,
    betsWon: sessionStats.wonCount, betsLost: sessionStats.lostCount, lastPlacedBet: betSummary,
    recentTickets: [betSummary, ...liveStatus.recentTickets.filter(t => String(t.ticketId) !== String(confirmation.ticketId))].slice(0, 15),
    pendingSubmissionId: null, confirmationStatus: 'confirmed', gateNotice: null });
  logger.info('SportyBetExecutor', `Confirmed Ticket #${confirmation.ticketId} via ${confirmation.source} (${status}); saved before resuming.`);
  return { placed: true, ticketId: String(confirmation.ticketId) };
}

function recordRejectedSubmission(submission, confirmation) {
  submissionJournal.save({ ...submission, state: confirmation.notSubmitted ? 'not_submitted' : 'rejected', confirmation });
  placedPickIds.add(String(submission.pick.id));
  pendingSubmission = null;
  placementPersistenceError = null;
  autoBet = requestedAutoBet;
  publishLiveStatus({ pendingSubmissionId: null, confirmationStatus: confirmation.notSubmitted ? 'not_submitted' : 'rejected', gateNotice: `Submission resolved: ${confirmation.reason}` });
  logger.warn('SportyBetExecutor', `Submission ${submission.id} resolved: ${confirmation.reason}. No wager is recorded; moving to another signal.`);
  return { placed: false, reason: 'bookmaker_rejected' };
}

async function reconcilePendingSubmission(engineFrame, targetPage) {
  if (!pendingSubmission || Date.now() - lastReconciliationAt < 30000) return;
  lastReconciliationAt = Date.now();
  try {
    const confirmation = pendingSubmission.confirmation?.confirmed ? pendingSubmission.confirmation
      : await confirmBetPlacementInMyBets(engineFrame, targetPage, pendingSubmission.pick, pendingSubmission.stake, 15000, pendingSubmission);
    if (confirmation.confirmed) {
      recordConfirmedSubmission(pendingSubmission, confirmation);
      await readSportyBetBalance(targetPage, engineFrame);
    } else if (confirmation.rejected || confirmation.notSubmitted) recordRejectedSubmission(pendingSubmission, confirmation);
    else {
      pendingSubmission = submissionJournal.save({ ...pendingSubmission, noReceiptEvidence: confirmation.noReceiptEvidence, lastCheck: new Date().toISOString(), evidence: confirmation.evidence, lastReason: confirmation.reason });
      pauseSubmission(`Submission ${pendingSubmission.id} is awaiting bookmaker evidence (${confirmation.reason}). Automatically rechecking every 30s; no duplicate wager will be sent.`);
      logger.warn('SportyBetExecutor', placementPersistenceError);
      if (confirmation.reason === 'provider_auth_expired') return { refreshProviderSession: true };
    }
  } catch (e) {
    pauseSubmission(`Submission reconciliation will retry: ${e.message}`);
    logger.warn('SportyBetExecutor', placementPersistenceError);
  }
}


// ─── Locate & Physically Click Target Odds Button ──────────────────────────
async function locateAndClickOddsButton(engineFrame, targetPage, pick) {
  const combinedMarket = `${pick.market || ''} ${pick.selection || ''}`.trim();
  const normCombined = combinedMarket.toLowerCase();

  logger.info('SportyBetExecutor', `🎯 Locating odds button for [${pick.home_team} vs ${pick.away_team}] | Market: [${combinedMarket}]...`);

  // Step 1: Ensure betslip is clean before selecting a new single bet
  await clearBetslipPhysically(engineFrame, targetPage);

  // Step 2: Switch to the required market tab
  await selectMarketFilter(engineFrame, targetPage, combinedMarket);
  await randomDelay(900, 1400);

  // Helper to resolve button coordinates inside the UPCOMING table (below Market filter)
  const findTargetInFrame = async () => {
    return await engineFrame.evaluate((args) => {
      const { homeTeam, awayTeam, combinedMarket, normCombined, aliases } = args;

      function norm(s) {
        return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();
      }

      function isMatch(teamCode, targetName) {
        const tNorm = norm(teamCode);
        const targetNorm = norm(targetName);
        if (tNorm === targetNorm) return true;
        for (const [canon, aliasList] of Object.entries(aliases)) {
          const cNorm = norm(canon);
          const aNorms = aliasList.map(norm);
          if ((tNorm === cNorm || aNorms.includes(tNorm)) && (targetNorm === cNorm || aNorms.includes(targetNorm))) {
            return true;
          }
        }
        return false;
      }

      const all = Array.from(document.querySelectorAll('*'));

      // Find Market filter bottom y so we strictly ignore the top "NOW" live scoreboard
      let marketFilterY = 320;
      const mfEl = all.find(el => el.children.length === 0 && /market\s*filter/i.test((el.innerText || '').trim()));
      if (mfEl) {
        marketFilterY = Math.round(mfEl.getBoundingClientRect().bottom);
      }

      // Find 3-letter team codes in the UPCOMING table below Market filter
      const teamBadges = all
        .filter(el => {
          if (el.children.length !== 0) return false;
          const t = (el.innerText || '').trim();
          if (!/^[A-Z]{3}$/.test(t)) return false;
          const r = el.getBoundingClientRect();
          return r.top > marketFilterY && r.left < 460 && r.width > 10;
        })
        .map(el => {
          const r = el.getBoundingClientRect();
          return {
            code: el.innerText.trim(),
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2)
          };
        });

      teamBadges.sort((a, b) => (Math.abs(a.y - b.y) > 12 ? a.y - b.y : a.x - b.x));
      const activeWeekBadges = teamBadges.slice(0, 20);

      let matchRowY = null;
      let matchedPair = null;
      let matchBadgeIndex = -1;
      for (let i = 0; i < activeWeekBadges.length - 1; i += 2) {
        const t1 = activeWeekBadges[i];
        const t2 = activeWeekBadges[i + 1];
        if (Math.abs(t1.y - t2.y) <= 15) {
          if (isMatch(t1.code, homeTeam) && isMatch(t2.code, awayTeam)) {
            matchRowY = Math.round((t1.y + t2.y) / 2);
            matchedPair = `${t1.code} - ${t2.code}`;
            matchBadgeIndex = i;
            break;
          }
        }
      }

      if (matchRowY === null) {
        return { found: false, reason: 'fixture_row_not_found' };
      }

      // HT/FT spans three button rows. Its +/-95px search also included the
      // neighbouring fixture's buttons. Bound every candidate by fixture midpoints.
      const pairY = i => (activeWeekBadges[i].y + activeWeekBadges[i + 1].y) / 2;
      const prevY = matchBadgeIndex >= 2 ? pairY(matchBadgeIndex - 2) : null;
      const nextY = matchBadgeIndex + 3 < activeWeekBadges.length ? pairY(matchBadgeIndex + 2) : null;
      const halfHeight = Math.min(...[prevY == null ? null : matchRowY - prevY, nextY == null ? null : nextY - matchRowY].filter(d => d > 0)) / 2;
      const rowTop = matchRowY - (Number.isFinite(halfHeight) ? halfHeight : 50);
      const rowBottom = matchRowY + (Number.isFinite(halfHeight) ? halfHeight : 50);
      const inFixtureRow = r => r.top + r.height / 2 > rowTop && r.top + r.height / 2 < rowBottom;

      // Case A: Over / Under (8 columns: OV 1.5, UN 1.5, OV 2.5, UN 2.5, OV 3.5, UN 3.5, OV 4.5, UN 4.5)
      if (normCombined.includes('over') || normCombined.includes('under') || normCombined.includes('ov ') || normCombined.includes('un ')) {
        const isOver = normCombined.includes('over') || normCombined.includes('ov ') || normCombined.startsWith('o ');
        let goalLine = '2.5';
        if (normCombined.includes('1.5')) goalLine = '1.5';
        else if (normCombined.includes('3.5')) goalLine = '3.5';
        else if (normCombined.includes('4.5')) goalLine = '4.5';

        const targetPrefix = isOver ? `OV ${goalLine}` : `UN ${goalLine}`;
        const candidates = all.filter(el => {
          const r = el.getBoundingClientRect();
          if (r.width < 25 || r.height < 18 || r.left < 300) return false;
          if (Math.abs((r.top + r.height / 2) - matchRowY) > 28) return false;
          const txt = (el.innerText || '').trim().toUpperCase();
          return txt.startsWith(targetPrefix) && /\d+\.\d{1,2}/.test(txt);
        });

        if (candidates.length > 0) {
          // Pick the tightest bounding box (the actual button)
          candidates.sort((a, b) => (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight));
          const btn = candidates[0];
          const r = btn.getBoundingClientRect();
          const oddMatch = btn.innerText.match(/(\d+\.\d{1,2})\s*$/);
          return {
            found: true,
            matchedPair,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            odd: oddMatch ? parseFloat(oddMatch[1]) : null,
            label: btn.innerText.trim().replace(/\n+/g, ' ')
          };
        }
      }

      // Case B: Goal Goal / No Goal (GG / NG)
      if (normCombined.includes('gg') || normCombined.includes('ng') || normCombined.includes('both teams') || normCombined.includes('btts') || normCombined.includes('goal goal') || normCombined.includes('no goal')) {
        const isNG = normCombined.includes('ng') || normCombined.includes('no goal') || normCombined.includes('btts no');
        const targetLabel = isNG ? 'NG' : 'GG';
        const candidates = all.filter(el => {
          const r = el.getBoundingClientRect();
          if (r.width < 25 || r.height < 18 || r.left < 300) return false;
          if (Math.abs((r.top + r.height / 2) - matchRowY) > 28) return false;
          const txt = (el.innerText || '').trim().toUpperCase();
          return txt.startsWith(targetLabel) && /\d+\.\d{1,2}/.test(txt);
        });

        if (candidates.length > 0) {
          candidates.sort((a, b) => (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight));
          const btn = candidates[0];
          const r = btn.getBoundingClientRect();
          const oddMatch = btn.innerText.match(/(\d+\.\d{1,2})\s*$/);
          return {
            found: true,
            matchedPair,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            odd: oddMatch ? parseFloat(oddMatch[1]) : null,
            label: btn.innerText.trim().replace(/\n+/g, ' ')
          };
        }
      }

      // Case C: Half Time / Full Time (1/1, 1/X, 1/2, X/1, X/X, X/2, 2/1, 2/X, 2/2)
      const htftMatch = normCombined.match(/([1x2]\/[1x2])/i);
      if (htftMatch) {
        const targetCode = htftMatch[1].toUpperCase();
        const candidates = all.filter(el => {
          const r = el.getBoundingClientRect();
          if (r.width < 25 || r.height < 18 || r.left < 300) return false;
          if (!inFixtureRow(r)) return false;
          const txt = (el.innerText || '').trim().toUpperCase();
          return txt.startsWith(targetCode) && /\d+\.\d{1,2}/.test(txt);
        });

        if (candidates.length > 0) {
          candidates.sort((a, b) => (a.offsetWidth * a.offsetHeight) - (b.offsetWidth * b.offsetHeight));
          const btn = candidates[0];
          const r = btn.getBoundingClientRect();
          const oddMatch = btn.innerText.match(/(\d+\.\d{1,2})\s*$/);
          return {
            found: true,
            matchedPair,
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            odd: oddMatch ? parseFloat(oddMatch[1]) : null,
            label: btn.innerText.trim().replace(/\n+/g, ' ')
          };
        }
      }

      // Case D: 1X2 (Match result: 1, X, 2) or Double Chance (1X, 12, X2)
      // Find the 3 odds columns on this matchRowY
      const rowOddEls = all
        .filter(el => {
          if (el.children.length !== 0) return false;
          const t = (el.innerText || '').trim();
          if (!/^\d+\.\d{1,2}$/.test(t)) return false;
          const r = el.getBoundingClientRect();
          return r.left > 320 && r.width > 15 && Math.abs((r.top + r.height / 2) - matchRowY) <= 24;
        })
        .map(el => {
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            odd: parseFloat(el.innerText.trim())
          };
        });

      rowOddEls.sort((a, b) => a.x - b.x);

      let oddIndex = 0; // Home Win / 1 / 1X
      if (
        normCombined === 'x' ||
        normCombined.includes('draw') ||
        normCombined === '12' ||
        normCombined.includes(' 12')
      ) {
        oddIndex = 1;
      } else if (
        normCombined === '2' ||
        normCombined.includes('away') ||
        normCombined === 'x2' ||
        normCombined.includes('x2')
      ) {
        oddIndex = 2;
      } else if (
        normCombined === '1' ||
        normCombined.includes('home') ||
        normCombined === '1x' ||
        normCombined.includes('1x')
      ) {
        oddIndex = 0;
      }

      const chosen = rowOddEls[oddIndex];
      if (chosen) {
        if (chosen.odd <= 1.01) {
          return { found: false, reason: `odd_locked_at_${chosen.odd}`, odd: chosen.odd };
        }
        return {
          found: true,
          matchedPair,
          x: chosen.x,
          y: chosen.y,
          odd: chosen.odd,
          label: `${combinedMarket} @ ${chosen.odd}`
        };
      }

      return { found: false, reason: 'odds_columns_not_found', rowCount: rowOddEls.length, matchRowY };
    }, {
      homeTeam: pick.home_team,
      awayTeam: pick.away_team,
      combinedMarket,
      normCombined,
      aliases: TEAM_ALIASES
    });
  };

  let targetBtn = await findTargetInFrame();
  if (!targetBtn || !targetBtn.found) {
    logger.warn('SportyBetExecutor', `⚠️ Could not locate odds button for [${pick.home_team} vs ${pick.away_team} | ${combinedMarket}] (${targetBtn?.reason || 'unknown'}).`);
    return null;
  }

  let { fOffsetX, fOffsetY } = await getFrameOffset(engineFrame);
  let clickPageX = targetBtn.x + fOffsetX;
  let clickPageY = targetBtn.y + fOffsetY;

  // Check if the target row is below the comfortable viewport fold; if so, scroll physically like a human!
  const viewportHeight = await targetPage.evaluate(() => window.innerHeight || 900);
  if (clickPageY > viewportHeight - 110 || clickPageY < 130) {
    const scrollDelta = clickPageY - Math.round(viewportHeight * 0.55);
    logger.info('SportyBetExecutor', `🖱️ Match row [${targetBtn.matchedPair}] is at y=${clickPageY}px. Scrolling mouse wheel by ${scrollDelta}px like a human...`);
    await hardwareScroll(targetPage, scrollDelta);

    // Re-read coordinates after physical scroll
    targetBtn = await findTargetInFrame();
    if (!targetBtn || !targetBtn.found) return null;
    ({ fOffsetX, fOffsetY } = await getFrameOffset(engineFrame));
    clickPageX = targetBtn.x + fOffsetX;
    clickPageY = targetBtn.y + fOffsetY;
  }

  logger.info('SportyBetExecutor', `🖱️ Physically clicking [${targetBtn.matchedPair} | ${targetBtn.label}] at (${clickPageX}, ${clickPageY})...`);
  await hardwareClickAt(targetPage, clickPageX, clickPageY);
  await randomDelay(1400, 2200);

  await switchToBetslipTab(engineFrame, targetPage);
  const verified = await verifyBetslipContainsPick(engineFrame, pick);
  if (!verified.ok) {
    logger.warn('SportyBetExecutor', `Selection withheld [${verified.reason}]: ${verified.bsPreview || ''}`);
    await clearBetslipPhysically(engineFrame, targetPage);
    return { found: false, reason: verified.reason };
  }

  return targetBtn;
}

// ─── Betslip Stake Entry & Bet Placement (100% Physical Hardware) ──────────
async function submitBetslipPlacement(engineFrame, targetPage, stakeVal, pick, clickedOddInfo) {
  if (pendingSubmission || placementPersistenceError) return { placed: false, reason: 'reconciliation_pending' };
  let submissionStarted = false;
  try {
    await scrollPageToTop(targetPage);
    await switchToBetslipTab(engineFrame, targetPage);
    const verified = await verifyBetslipContainsPick(engineFrame, pick);
    if (!verified.ok) {
      logger.warn('SportyBetExecutor', `Placement withheld [${verified.reason}]: ${verified.bsPreview || ''}`);
      return { placed: false, reason: verified.reason };
    }
    let { fOffsetX, fOffsetY } = await getFrameOffset(engineFrame);

    logger.info('SportyBetExecutor', `📝 Entering stake of ${currencySymbol}${stakeVal} into Betslip via physical hardware click & keyboard...`);

    const findBetslipCoords = async () => {
      return await engineFrame.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const stakeInput = inputs.find(i => {
          const r = i.getBoundingClientRect();
          return r.width > 30 && r.height > 15 && r.x > 800;
        });
        if (!stakeInput) return null;

        const ir = stakeInput.getBoundingClientRect();
        const all = Array.from(document.querySelectorAll('*'));
        const totalLabel = all.find(el => el.children.length === 0 && /total\s*stake/i.test((el.innerText || '').trim()));
        const tr = totalLabel ? totalLabel.getBoundingClientRect() : null;

        return {
          inputX: Math.round(ir.left + ir.width * 0.65),
          inputY: Math.round(ir.top + ir.height / 2),
          blurX: tr ? Math.round(tr.left + 30) : Math.round(ir.left - 25),
          blurY: tr ? Math.round(tr.top + tr.height / 2) : Math.round(ir.top + ir.height / 2)
        };
      });
    };

    let betslipCoords = await findBetslipCoords();
    if (!betslipCoords) {
      await switchToBetslipTab(engineFrame, targetPage);
      betslipCoords = await findBetslipCoords();
    }

    if (!betslipCoords) {
      logger.warn('SportyBetExecutor', '⚠️ Stake input not found in Betslip.');
      return { placed: false, reason: 'stake_input_not_found' };
    }

    // 1. Physical click inside the stake input box
    await hardwareClickAt(targetPage, betslipCoords.inputX + fOffsetX, betslipCoords.inputY + fOffsetY);
    await randomDelay(150, 280);

    // 2. Clear any existing text using physical Backspace, Delete, and Ctrl+A
    await targetPage.keyboard.press('End');
    await delay(30);
    await targetPage.keyboard.press('Backspace');
    await delay(30);
    await targetPage.keyboard.down('Control');
    await targetPage.keyboard.press('KeyA');
    await targetPage.keyboard.up('Control');
    await delay(30);
    await targetPage.keyboard.press('Backspace');
    await targetPage.keyboard.press('Delete');
    await randomDelay(100, 180);

    // 3. Physically type each digit of the stake via hardware keyboard
    for (const char of String(stakeVal)) {
      await targetPage.keyboard.type(char, { delay: 45 + Math.floor(Math.random() * 40) });
    }
    await randomDelay(150, 250);

    // Commit by blurring the input. Enter can submit the form before validation finishes.
    await hardwareClickAt(targetPage, betslipCoords.blurX + fOffsetX, betslipCoords.blurY + fOffsetY);
    await randomDelay(600, 1000);

    const enteredStake = await engineFrame.evaluate(() => {
      const input = Array.from(document.querySelectorAll('input')).find(i => {
        const r = i.getBoundingClientRect();
        return r.width > 30 && r.height > 15 && r.x > 800;
      });
      return input ? Number(String(input.value).replace(/,/g, '')) : null;
    });
    if (enteredStake !== stakeVal) {
      logger.warn('SportyBetExecutor', `Stake entry mismatch: expected ${stakeVal}, found ${enteredStake}. Placement withheld.`);
      return { placed: false, reason: 'stake_input_mismatch' };
    }

    // Save OCR Vision Screenshot BEFORE clicking Place Bet
    try {
      await targetPage.screenshot({ path: path.join(VISION_DIR, 'latest_betslip_staked.png') });
    } catch (e) {}

    // Fresh frame offset right before clicking Place Bet
    ({ fOffsetX, fOffsetY } = await getFrameOffset(engineFrame));

    // Locate and verify "Place Bet" button
    const placeBetBtn = await engineFrame.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, .btn, [role="button"]'));
      const btn = buttons.find(b => (b.innerText || '').trim().toLowerCase().includes('place bet'));
      const betslip = document.querySelector('.betslip, [class*="betslip"], app-betslip');
      const bsText = betslip ? betslip.innerText.replace(/\n+/g, ' ') : '';
      if (btn) {
        const r = btn.getBoundingClientRect();
        const isDisabled = btn.disabled || btn.classList.contains('disabled') || btn.classList.contains('place-bet--disabled');
        return {
          found: true,
          disabled: isDisabled,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          bsText
        };
      }
      return { found: false, bsText };
    });

    if (!placeBetBtn.found) {
      logger.warn('SportyBetExecutor', '⚠️ "Place Bet" button not found in Betslip.');
      return { placed: false, reason: 'place_bet_btn_not_found' };
    }

    if (placeBetBtn.disabled || /EXPIRED/i.test(placeBetBtn.bsText)) {
      logger.warn('SportyBetExecutor', '⚠️ Selection expired or "Place Bet" button disabled. Clearing betslip...');
      await clearBetslipPhysically(engineFrame, targetPage);
      return { placed: false, reason: 'place_bet_disabled_or_expired' };
    }

    // Resolve click coordinates using exact CDP element bounding box when available
    let clickX = placeBetBtn.x + fOffsetX;
    let clickY = placeBetBtn.y + fOffsetY;
    try {
      const btnHandle = await engineFrame.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button, .btn, [role="button"]'));
        return buttons.find(b => (b.innerText || '').trim().toLowerCase().includes('place bet')) || null;
      });
      if (btnHandle && btnHandle.asElement()) {
        const box = await btnHandle.asElement().boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          clickX = Math.round(box.x + box.width / 2);
          clickY = Math.round(box.y + box.height / 2);
        }
      }
    } catch (e) {}

    // Snapshot and persist BEFORE the click. A restart must never erase an uncertain wager.
    const baseline = await readMyBetsTickets(engineFrame);
    const baselineIds = [...new Set([...baseline.map(t => String(t.ticketId)), ...db.getRecentBets(1000).map(b => String(b.ticket_id)).filter(Boolean)])];
    const commitBoard = await extractBoardState(engineFrame);
    if (!verified.fixtureId || commitBoard.weekNumber !== Number(pick.round_number) || !Number.isFinite(commitBoard.remainingSec) || commitBoard.remainingSec <= 15) {
      return { placed: false, reason: 'place_bet_disabled_or_expired' };
    }
    const confirmationIO = await createConfirmationIO(engineFrame, targetPage);
    const finalSlip = await verifyBetslipContainsPick(engineFrame, pick);
    if (!finalSlip.ok || finalSlip.fixtureId !== verified.fixtureId) return { placed: false, reason: 'betslip_changed_before_submission' };
    const rejectionBeforeClick = await confirmationIO.readRejection();
    if (rejectionBeforeClick) return { placed: false, reason: rejectionBeforeClick };
    pendingSubmission = submissionJournal.save({ id: randomUUID(), state: 'pending', pick,
      fixtureId: verified.fixtureId, stake: stakeVal, odds: clickedOddInfo?.odd || pick.implied_odd || pick.odds || 1.5,
      submittedAt: new Date().toISOString(), acceptanceDeadline: new Date(Date.now() + commitBoard.remainingSec * 1000).toISOString(), baselineIds });
    publishLiveStatus({ pendingSubmissionId: pendingSubmission.id, confirmationStatus: 'confirming', placementStatus: 'confirming', gateNotice: 'Submitting once and waiting for bookmaker receipt confirmation.' });
    logger.info('SportyBetExecutor', `Submitting ${pendingSubmission.id}: one physical Place Bet click; receipt confirmation follows.`);
    submissionStarted = true;
    await hardwareClickAt(targetPage, clickX, clickY);
    try { await targetPage.screenshot({ path: path.join(VISION_DIR, 'latest_bet_confirmed.png') }); } catch (e) {}
    const confirmation = await confirmBetPlacementInMyBets(engineFrame, targetPage, pick, stakeVal, 30000, pendingSubmission);
    if (confirmation.confirmed) {
      const result = recordConfirmedSubmission(pendingSubmission, confirmation);
      await readSportyBetBalance(targetPage, engineFrame);
      return result;
    }
    if (confirmation.rejected || confirmation.notSubmitted) return recordRejectedSubmission(pendingSubmission, confirmation);
    pendingSubmission = submissionJournal.save({ ...pendingSubmission, noReceiptEvidence: confirmation.noReceiptEvidence, lastReason: confirmation.reason, evidence: confirmation.evidence });
    pauseSubmission(`Bookmaker submission could not be confirmed yet (${pendingSubmission.id}). Automatically checking My Bets and Bet History; resubmission is blocked.`);
    return { placed: false, reason: 'placement_uncertain' };
  } catch (err) {
    logger.error('SportyBetExecutor', `Error during bet placement: ${err.message}`);
    if (submissionStarted && pendingSubmission) {
      placementPersistenceError = `Bookmaker submission interrupted: ${err.message}. Reconcile before resuming.`;
      autoBet = false;
      publishLiveStatus({ autoBetActive: false, gateNotice: placementPersistenceError });
    }
    if (pendingSubmission?.confirmation?.confirmed) return { placed: true, ticketId: pendingSubmission.confirmation.ticketId, reason: 'persistence_pending' };
    return { placed: false, reason: err.message };
  }
}

// ─── Exact Strategy Selection & Filtering Engine ──────────────────────────
// Replicates the exact filtering logic from Market Analytics & Staking Lab (NexusPanel)
function matchesStrategyFilter(pick, strategy, options = {}) {
  if (!pick) return false;

  const rawType = (pick.category || pick.server_pick_type || pick.pick_type || pick.engine || '').toLowerCase();
  const normalizedTypeMap = {
    high_chance: 'high_value',
    high_value: 'high_value',
    ai_best: 'ai_best_pick',
    ai_best_pick: 'ai_best_pick',
    ai_high_risk: 'ai_best_pick',
    high_risk: 'ai_best_pick',
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

  // Strategy preset matching
  const strat = (strategy || 'all').toLowerCase();
  if (strat !== 'all') {
    if (strat === 'safest') {
      if (pType !== 'safest') return false;
    } else if (strat === 'high_value') {
      if (pType !== 'high_value') return false;
    } else if (strat === 'ai_best_pick' || strat === 'ai_best') {
      if (pType !== 'ai_best_pick' && pick.is_best_pick !== true && rawType !== 'high_risk' && rawType !== 'ai_high_risk') return false;
    } else if (strat === 'goals_engine' || strat === 'goals') {
      if (pType !== 'goals_engine') return false;
    } else if (strat === 'goals_market') {
      if (!mkt.includes('over') && !mkt.includes('under') && !mkt.includes('both teams') && !mkt.includes('gg') && !mkt.includes('btts')) {
        return false;
      }
    } else if (strat === 'high_odds') {
      if (odd < 3.0) return false;
    }
  }

  // Market / Signal Type chips check (when specific markets are selected in UI)
  const sigTypes = options.selectedSignalTypes || selectedSignalTypes || ['all'];
  if (!sigTypes.includes('all') && sigTypes.length > 0) {
    const matchesType = (typeId) => {
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
        case 'high_odds':     return odd >= 3.0;
        case 'goals_engine':  return mkt.includes('over 2.5') || mkt.includes('under 2.5') || mkt.includes('over 3.5') || mkt.includes('under 3.5');
        case 'goals_market':  return mkt.includes('over') || mkt.includes('under') || mkt.includes('goal') || mkt.includes('btts');
        case 'safest':        return odd <= 1.65 || (pick.probability != null && parseFloat(pick.probability) >= 75);
        case 'high_chance':   return odd > 1.65 && odd < 3.2;
        case 'high_risk':     return odd >= 3.2 || (pick.probability != null && parseFloat(pick.probability) < 48);
        default:              return false;
      }
    };
    if (!sigTypes.some(t => matchesType(t))) return false;
  }

  // Tier check when strategy is 'all'
  const tiers = options.selectedTiers || selectedTiers || ['safest', 'high_chance', 'high_risk'];
  if (strat === 'all' && Array.isArray(tiers) && tiers.length > 0 && tiers.length < 3) {
    const pickTier = (pick.pick_type || '').toLowerCase();
    if (pickTier && !tiers.includes(pickTier)) return false;
  }

  // Odds bounds
  if (options.minOdds > 0 && odd < options.minOdds) return false;
  if (options.maxOdds > 0 && odd > options.maxOdds) return false;

  // Confidence bounds
  const prob = pick.probability != null ? parseFloat(pick.probability) : 0;
  if (options.minConfidence > 0 && prob < options.minConfidence) return false;

  // Team search
  if (options.teamSearch && options.teamSearch.trim()) {
    const t = options.teamSearch.trim().toLowerCase();
    const h = (pick.home_team || '').toLowerCase();
    const a = (pick.away_team || '').toLowerCase();
    if (!h.includes(t) && !a.includes(t)) return false;
  }

  return true;
}

// ─── Live Ticket Settlement Tracker (My Bets WON / LOST) ───────────────────
const settledTicketTracker = new Map(); // ticketId or signalId -> "WON" | "LOST"
let lastClearedCompletedBetsCount = 0; // Tracks milestone clears (every 100 completed bets) // ticketId or signalId -> "WON" | "LOST"

// Parses a DB timestamp to epoch ms. SQLite CURRENT_TIMESTAMP values carry no timezone and are UTC.
function parseDbTimestampMs(value) {
  if (!value) return 0;
  let s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) s = s.replace(' ', 'T') + 'Z';
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Returns any active placed bet that has not yet settled (WON or LOST).
 * In Virtual Football, matches conclude in ~2-3 minutes.
 * Progressive staking MUST wait for a known result, even after a restart or a delayed settlement.
 */
function getUnsettledActiveBet() {
  try {
    const recent = db.getRecentBets(100, 'PENDING');
    for (const b of recent) {
      if (!b.ticket_id || !/^\d{8,12}$/.test(String(b.ticket_id))) continue;
      let st = (b.status || "").toUpperCase();
      if (b.ticket_id && settledTicketTracker.has(String(b.ticket_id))) {
        st = settledTicketTracker.get(String(b.ticket_id));
      }
      if (b.signal_id && settledTicketTracker.has(String(b.signal_id))) {
        st = settledTicketTracker.get(String(b.signal_id));
      }
      if (st === 'PENDING' || st === 'OPEN') return b;
    }
  } catch (e) {}
  return null;
}

// ─── Filter & Rank Signals for the Active SportyBet Board ──────────────────
function selectAiBestSignalsForBoard(pendingPicks, boardState) {
  const { fixtures, weekNumber } = boardState;
  if (!fixtures || fixtures.length === 0) return [];

  // Progressive Staking Gate (Martingale / Kelly):
  // NEVER place another bet if there is an active unsettled pending bet!
  if (stakeMode.startsWith("martingale") || stakeMode.startsWith("kelly")) {
    const pendingBet = getUnsettledActiveBet();
    if (pendingBet) {
      return []; // Must wait for previous bet outcome before picking next match
    }
    if (weekNumber != null && Number(weekNumber) === lastPlacedWeek) return [];
  }

  const matchedForBoard = [];
  for (const pick of pendingPicks) {
    if (!pick || !pick.home_team || !pick.away_team) continue;

    if (placedPickIds.has(String(pick.id))) continue;

    if (weekNumber !== null && pick.round_number != null && Number(pick.round_number) !== Number(weekNumber)) {
      continue;
    }

    const matchingRow = fixtures.find(f => matchTeams(pick.home_team, f.homeCode) && matchTeams(pick.away_team, f.awayCode));
    if (!matchingRow) continue;

    const matchKey = `W${weekNumber || pick.round_number || 0}_${matchingRow.homeCode}_${matchingRow.awayCode}`;
    if (placedRoundTeams.has(matchKey)) continue;

    // Check minimum odds (Golden Race disables <= 1.01 odds)
    const pickOdd = pick.sportybet_odd && pick.sportybet_odd > 0
      ? pick.sportybet_odd
      : (pick.implied_odd != null ? parseFloat(pick.implied_odd) : (pick.odds != null ? parseFloat(pick.odds) : 0));
    if (pickOdd > 0 && pickOdd <= 1.01) continue;

    // Evaluate exact strategy and filter criteria
    if (!matchesStrategyFilter(pick, selectedStrategy, { minOdds, maxOdds, minConfidence, teamSearch })) {
      continue;
    }

    matchedForBoard.push({
      ...pick,
      _matchKey: matchKey,
      _prob: pick.probability != null ? parseFloat(pick.probability) : 0,
      _rowIndex: matchingRow.rowIndex
    });
  }

  if (matchedForBoard.length === 0) return [];

  // When testing Martingale: select the single #1 qualifying signal for this round
  if (stakeMode.startsWith('martingale')) {
    return [matchedForBoard[0]];
  }

  return matchedForBoard.slice(0, 2);
}

// ─── Consecutive Losses & Martingale Staking Calculation ────────────────────
function getConsecutiveLossStreak() {
  try {
    const recent = db.getRecentBets(1000);
    let count = 0;
    let accumulatedLoss = 0;
    let lastLossStake = null;
    const seenTickets = new Set();
    for (const b of recent) {
      if (!b.ticket_id || !/^\d{8,12}$/.test(String(b.ticket_id))) continue;
      const ticket = String(b.ticket_id);
      if (seenTickets.has(ticket)) continue;
      seenTickets.add(ticket);
      let st = (b.status || '').toUpperCase();
      if (b.ticket_id && settledTicketTracker.has(String(b.ticket_id))) {
        st = settledTicketTracker.get(String(b.ticket_id));
      }
      if (st === 'PENDING' || st === 'VOID' || !st) continue;
      if (st === 'LOST') {
        if (lastLossStake === null) lastLossStake = Number(b.stake) || null;
        count++;
        accumulatedLoss += Number(b.stake) || 0;
      } else if (st === 'WON') {
        break;
      }
    }
    return { count, accumulatedLoss, lastLossStake };
  } catch (e) {
    return { count: 0, accumulatedLoss: 0 };
  }
}

function calculateCurrentStake(pickOdds = 2.0) {
  const minStake = 10;
  const base = Math.max(minStake, stakeAmount || defaultStake);
  const streak = getConsecutiveLossStreak();
  const consecutiveLosses = streak.count;
  const cap = (stakingScaling && stakingScaling !== 'uncapped') ? parseInt(stakingScaling, 10) : null;

  const activeLosses = (Number.isInteger(cap) && cap > 0) ? consecutiveLosses % cap : consecutiveLosses;
  const isCappedReset = consecutiveLosses > 0 && activeLosses === 0;

  let calculated = base;

  switch (stakeMode) {
    case 'fixed':
      calculated = base;
      break;

    case 'martingale_1_5': {
      calculated = activeLosses > 0 ? (streak.lastLossStake || base) * 1.5 : base;
      break;
    }

    case 'martingale_2_0': {
      if (activeLosses === 0) {
        calculated = base;
      } else if (pickOdds >= 2.0) {
        calculated = base * Math.pow(2.0, activeLosses);
      } else {
        const targetProfit = base;
        const netOdds = Math.max(0.15, pickOdds - 1.0);
        calculated = (streak.accumulatedLoss + targetProfit) / netOdds;
      }
      break;
    }

    case 'martingale_3_0': {
      calculated = base * Math.pow(3.0, activeLosses);
      break;
    }

    case 'percent':
    case 'percentage':
    case 'compounding': {
      const pct = stakePercentage || 2;
      const bal = currentBalance || startingBankroll || 15000;
      calculated = (bal * pct) / 100;
      break;
    }

    default:
      calculated = base;
      break;
  }

  // Golden Race requires NGN 5 increments. Round up so accepted stakes never fall below the plan.
  const finalStake = Math.max(minStake, Math.ceil(calculated / 5) * 5);
  return {
    stake: finalStake,
    consecutiveLosses: activeLosses,
    accumulatedLoss: streak.accumulatedLoss,
    isCappedReset
  };
}

// ─── Live Ticket Settlement Tracker (My Bets WON / LOST) ───────────────────
// settledTicketTracker declared above

async function syncSettledTicketsFromFrame(engineFrame) {
  if (!engineFrame || engineFrame.isDetached()) return;
  try {
    const tickets = await readMyBetsTickets(engineFrame);

    let updated = false;
    for (const t of tickets) {
      if (t.status !== 'WON' && t.status !== 'LOST' && t.status !== 'VOID') continue;
      const tidStr = String(t.ticketId);
      if (!settledTicketTracker.has(tidStr)) {
        settledTicketTracker.set(tidStr, t.status);

        // Verify if already settled in DB to prevent duplicate stats increment
        const recentBets = db.getRecentBets(50);
        const existingBet = recentBets.find(b => String(b.ticket_id) === tidStr || String(b.id) === tidStr);
        if (!existingBet) continue; // Only synchronize tickets belonging to this executor.
        const alreadySettledInDb = (existingBet.status || '').toUpperCase() === t.status;

        if (!alreadySettledInDb) {
          if (t.status === "WON") {
            sessionStats.wonCount++;
            logger.info("SportyBetExecutor", `🏆 Ticket #${t.ticketId} SETTLED: WON! Martingale resets to base ₦${stakeAmount}.`);
            db.updateBetSettlement(t.ticketId, 'WON', (Number(existingBet.stake) || 0) * ((Number(existingBet.odds) || 1) - 1));
          } else if (t.status === "LOST") {
            sessionStats.lostCount++;
            logger.info("SportyBetExecutor", `📊 Ticket #${t.ticketId} SETTLED: LOST. Advancing Martingale progression.`);
            db.updateBetSettlement(t.ticketId, 'LOST', -(Number(existingBet.stake) || 0));
          }
          if (t.status === 'VOID') db.updateBetSettlement(t.ticketId, 'VOID', 0);
        } else {
          logger.info("SportyBetExecutor", `📋 Ticket #${t.ticketId} settlement synchronized: ${t.status}.`);
        }
        for (const rt of liveStatus.recentTickets) {
          if (String(rt.ticketId) === String(t.ticketId)) {
            rt.status = t.status;
          }
        }
        updated = true;
      }
    }
    if (updated) {
      const nextPlan = calculateCurrentStake();
      currentStake = nextPlan.stake;
      publishLiveStatus({
        betsWon: sessionStats.wonCount,
        betsLost: sessionStats.lostCount,
        currentStake,
        stakeMode,
        winRate: (sessionStats.wonCount + sessionStats.lostCount > 0)
          ? `${Math.round((sessionStats.wonCount / (sessionStats.wonCount + sessionStats.lostCount)) * 100)}%`
          : '0%'
      });
    }
  } catch (e) {}
}

async function syncSettledSignalsFromCollector() {
  try {
    await signalCollector.pollSettledPicks();
    const settled = signalCollector.settledPicks || [];
    const pendingBets = db.getRecentBets(50).filter(b => (b.status || '').toUpperCase() === 'PENDING');

    let updated = false;
    for (const bet of pendingBets) {
      const match = settled.find(s => String(s.id) === String(bet.signal_id));
      if (match && match.status && match.status !== 'pending') {
        const st = match.status.toUpperCase();
        let pnl = 0;
        if (st === 'WON') {
          pnl = ((Number(bet.stake) || 10) * (Number(bet.odds) || 1.0)) - (Number(bet.stake) || 10);
          sessionStats.wonCount++;
          logger.info('SportyBetExecutor', `🏆 Signal #${bet.signal_id} (${bet.home_team} vs ${bet.away_team}) SETTLED: WON (+₦${pnl.toFixed(2)})! Martingale streak reset to base ₦${stakeAmount}.`);
        } else if (st === 'LOST') {
          pnl = -(Number(bet.stake) || 10);
          sessionStats.lostCount++;
          logger.info('SportyBetExecutor', `📊 Signal #${bet.signal_id} (${bet.home_team} vs ${bet.away_team}) SETTLED: LOST (-₦${Math.abs(pnl).toFixed(2)}). Advancing Martingale progression.`);
        }
        db.updateBetSettlement(bet.signal_id, st, pnl);
        if (bet.ticket_id) settledTicketTracker.set(String(bet.ticket_id), st);
        settledTicketTracker.set(String(bet.signal_id), st);
        updated = true;
      }
    }
    if (updated) {
      const nextPlan = calculateCurrentStake();
      currentStake = nextPlan.stake;
      publishLiveStatus({
        betsWon: sessionStats.wonCount,
        betsLost: sessionStats.lostCount,
        currentStake,
        stakeMode
      });
    }
  } catch (e) {
    logger.warn('SportyBetExecutor', `Settled signal sync notice: ${e.message}`);
  }
}

// ─── Main Execution & Signal Monitoring Loop ──────────────────────────────
function getPlacementGate({ health, boardState, activePending, signalCount }) {
  if (placementPersistenceError) return { code: 'placement_paused', reason: placementPersistenceError };
  if (!autoBet) return { code: 'auto_bet_disabled', reason: 'Auto-Bet is OFF. Enable Auto-Bet On Signals to place matching signals.' };
  if (isShuttingDown) return { code: 'shutting_down', reason: 'Executor is shutting down.' };
  if (!health.ready) return { code: 'board_unavailable', reason: health.reason || 'Waiting for a readable upcoming board and countdown.' };
  if (activePending) {
    const desc = activePending.ticket_id ? `Ticket #${activePending.ticket_id}` : `Signal #${activePending.signal_id}`;
    return { code: 'awaiting_settlement', reason: `Waiting for ${desc} (${activePending.home_team || '?'} vs ${activePending.away_team || '?'}) to settle before placing the next stake.` };
  }
  if (boardState.remainingSec <= 15) return { code: 'kickoff_guard', reason: `Week ${boardState.weekNumber} locks in ${boardState.remainingSec}s (15s safety guard). Waiting for next matchday.` };
  if (!signalCount) return { code: 'no_matching_signal', reason: 'Waiting for an unstaked signal that matches the board and selected filters.' };
  return { code: 'ready', reason: null };
}

async function startSportyBetExecutor() {
  let browser = null;
  let page = null;

  try {
    currentStake = calculateCurrentStake().stake;
    publishLiveStatus({ currentStake });
    page = await config.connect({
      headless,
      userDataDir: targetProfileDir
    });
    browser = page.browser();

    browser.on('disconnected', () => {
      logger.warn('SportyBetExecutor', 'Browser window closed. Shutting down executor cleanly.');
      publishLiveStatus({ running: false });
      process.exit(0);
    });

    // Step 1: Ensure Authentication with Permanent Profile
    const authed = await checkAndEnsureAuth(page);
    if (!authed) {
      logger.warn('SportyBetExecutor', 'Initial authentication check incomplete. Will retry in loop...');
    }

    // Step 2: Navigate to England League
    let engineFrame = await navigateToEnglandLeague(page);

    // Sanitize any legacy phantom tickets in DB (fixture IDs falsely saved as tickets)
    try {
      const recentBets = db.getRecentBets(100);
      let cleaned = 0;
      for (const b of recentBets) {
        if (b.ticket_id && (String(b.ticket_id).startsWith('400') || !/^\d{8,12}$/.test(String(b.ticket_id)))) {
          db.updateBetSettlement(b.ticket_id, 'VOID', 0);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.info('SportyBetExecutor', `🧹 Voided ${cleaned} legacy phantom tickets with fixture IDs.`);
      }
    } catch (e) {}

    logger.info('SportyBetExecutor', '====================================================');
    logger.info('SportyBetExecutor', '⚡ SPORTYBET HUMAN AI EXECUTION LOOP ACTIVE');
    logger.info('SportyBetExecutor', '📡 Synchronizing live AI Best Signals from Predictor Server...');

    let iteration = 0;
    let lastGateLogKey = null;
    let lastGateLogAt = 0;
    const boardHealth = new SportyBetBoardHealth();

    while (!isShuttingDown) {
      iteration++;
      try {
        reloadDynamicConfig();
        // 1. Poll live signals and settlement from remote VPS Predictor Server every cycle
        try {
          await signalCollector.pollPendingPicks();
          await syncSettledSignalsFromCollector();
          signalCollector.cleanupStalePendingPicks();
          signalCollector.saveToStorage();
        } catch (pollErr) {
          logger.warn('SportyBetExecutor', `Signal poll notice: ${pollErr.message}`);
        }

        // 2. Periodic auth & balance verification
        if (iteration % 6 === 0) {
          const authCheck = await evaluateSportyBetAuth(page);
          if (!authCheck.isLoggedIn && authCheck.visiblePhone) {
            logger.warn('SportyBetExecutor', '⚠️ Session timeout/logout detected! Re-authenticating like a human...');
            await checkAndEnsureAuth(page);
            engineFrame = await navigateToEnglandLeague(page);
          } else {
            await readSportyBetBalance(page, engineFrame);
            await syncSettledTicketsFromFrame(engineFrame);
          }
        }

        // 3. Verify Golden Race engine frame health
        if (!engineFrame || engineFrame.isDetached()) {
          logger.info('SportyBetExecutor', '🔄 Re-acquiring Golden Race engine frame...');
          engineFrame = await getEngineFrame(page);
          if (!engineFrame) {
            engineFrame = await navigateToEnglandLeague(page);
          }
        }

        if (engineFrame) {
          const reconciliation = await reconcilePendingSubmission(engineFrame, page);
          if (reconciliation?.refreshProviderSession && Date.now() - lastProviderRecoveryAt > 120000) {
            lastProviderRecoveryAt = Date.now();
            engineFrame = await recoverStalledBoard(page, 'Provider receipt/history session expired; renewing the session before reconciliation');
            continue;
          }
          // Read bookmaker outcomes before selecting the next progressive stake, every cycle.
          if (getUnsettledActiveBet()) await switchToMyBetsTab(engineFrame, page);
          await syncSettledTicketsFromFrame(engineFrame);
          const boardState = await extractBoardState(engineFrame);
          const { remainingSec, timerText, weekNumber, fixtures } = boardState;
          const health = boardHealth.observe(boardState);

          // Season rollover: week numbers restart at 1, so per-season placement guards must be cleared
          if (Number.isInteger(weekNumber)) {
            if (lastSeenBoardWeek !== null && weekNumber < lastSeenBoardWeek) {
              logger.info('SportyBetExecutor', `🔄 New season detected (Week ${lastSeenBoardWeek} -> ${weekNumber}). Clearing per-season placement guards.`);
              placedRoundTeams.clear();
              lastPlacedWeek = null;
            }
            lastSeenBoardWeek = weekNumber;
          }

          publishLiveStatus({
            currentWeek: weekNumber,
            remainingSeconds: remainingSec,
            networkStatus: health.status === 'stalled' ? 'degraded' : (health.ready ? 'online' : 'reconnecting'),
            boardStatus: health.status,
            boardError: health.reason
          });

          if (health.shouldRecover) {
            boardHealth.markRecoveryAttempt();
            engineFrame = await recoverStalledBoard(page, health.reason);
            boardHealth.reset();
            // Read the replacement board in a new cycle; never use pre-reload signals or coordinates.
            await delay(5000);
            continue;
          }

          const activePending = (stakeMode.startsWith("martingale") || stakeMode.startsWith("kelly")) ? getUnsettledActiveBet() : null;
          const pendingPicks = Array.from(signalCollector.pendingPicks.values());
          const targetSignals = health.ready ? selectAiBestSignalsForBoard(pendingPicks, boardState) : [];

          const gate = getPlacementGate({ health, boardState, activePending, signalCount: targetSignals.length });
          publishLiveStatus({ placementStatus: gate.code, gateNotice: gate.reason, matchingSignalCount: targetSignals.length });
          const gateLogKey = `${weekNumber}:${gate.code}:${activePending?.ticket_id || ''}`;
          if (gate.code !== 'ready' && (gateLogKey !== lastGateLogKey || Date.now() - lastGateLogAt >= 30000)) {
            logger.info('SportyBetExecutor', `⏸ Placement blocked [${gate.code}]: ${gate.reason}`);
            lastGateLogAt = Date.now();
          }
          lastGateLogKey = gateLogKey;
          if (iteration % 4 === 1 || targetSignals.length > 0) {
            logger.info(
              'SportyBetExecutor',
              `📊 England League Week ${weekNumber || '?'} (⏱️ ${timerText} | ${remainingSec}s left) | Visible Fixtures: ${fixtures.length} | Matching Unstaked AI Signals: ${targetSignals.length} | AutoBet: ${autoBet ? 'ON' : 'OFF'} | Placement: ${gate.code}`
            );
          }

          // ─── 100 Completed Bets Maintenance Check ───
          try {
            const betStats = db.getBetStats();
            const totalCompleted = (betStats.wonBets || 0) + (betStats.lostBets || 0);
            if (totalCompleted >= 100 && (lastClearedCompletedBetsCount === 0 || totalCompleted - lastClearedCompletedBetsCount >= 100)) {
              lastClearedCompletedBetsCount = totalCompleted;
              logger.info("SportyBetExecutor", `🧹 [Auto Maintenance] Reached milestone of ${totalCompleted} completed bets! Checking for "Clear Completed" on Golden Race...`);
              const cleared = await clearCompletedTicketsPhysically(engineFrame, page);
              if (cleared) {
                logger.info("SportyBetExecutor", `✅ "Clear Completed" successfully clicked! (Next auto-clear at ${totalCompleted + 100} completed bets).`);
              }
            }
          } catch (cleanErr) {
            logger.warn("SportyBetExecutor", `Completed tickets check notice: ${cleanErr.message}`);
          }

          if (gate.code === 'ready') {
            if (remainingSec <= 15) {
              logger.info('SportyBetExecutor', `⏳ Matchday Week ${weekNumber} locks in ${remainingSec}s (<= 15s safety guard). Holding for next matchday...`);
            } else {
              for (const signal of targetSignals) {
                if ((stakeMode.startsWith("martingale") || stakeMode.startsWith("kelly")) && getUnsettledActiveBet()) {
                  logger.info("SportyBetExecutor", "⏳ Active bet is still unsettled. Holding placement until settlement.");
                  break;
                }
                if (!autoBet || isShuttingDown) break;

                // Re-verify remaining time before each bet in the round
                const freshBoard = await extractBoardState(engineFrame);
                const freshHealth = boardHealth.observe(freshBoard);
                const stillMatches = freshBoard.fixtures.some(f => matchTeams(signal.home_team, f.homeCode) && matchTeams(signal.away_team, f.awayCode));
                if (!freshHealth.ready || freshBoard.remainingSec <= 14 || freshBoard.weekNumber !== weekNumber || !stillMatches) {
                  logger.info('SportyBetExecutor', 'Board unavailable, changed matchday, or too close to kickoff. Deferring remaining signals.');
                  break;
                }

                logger.info(
                  'SportyBetExecutor',
                  `🤖 Executing AI Best Signal #${signal.id} [Week ${weekNumber} | ${(signal.pick_type || 'AI').toUpperCase()} | ${Number(signal.probability || 0).toFixed(1)}%]: ${signal.home_team} vs ${signal.away_team} -> ${signal.market} (@${signal.implied_odd})`
                );

                // Step 1: Select pick into Betslip and verify pick confirmed
                let clickedOdd = await locateAndClickOddsButton(engineFrame, page, signal);
                if (!clickedOdd || !clickedOdd.found) {
                  logger.warn('SportyBetExecutor', `⚠️ Selection not confirmed in Betslip. Retrying odds click...`);
                  await delay(800);
                  clickedOdd = await locateAndClickOddsButton(engineFrame, page, signal);
                }

                if (clickedOdd && clickedOdd.found) {
                  const actualOdd = clickedOdd?.odd || signal.implied_odd || signal.odds || 1.5;
                  const stakePlan = calculateCurrentStake(actualOdd);
                  currentStake = stakePlan.stake;
                  logger.info(
                    'SportyBetExecutor',
                    `💰 Staking Plan [${stakeMode.toUpperCase()}]: ₦${currentStake} (Loss Streak: ${stakePlan.consecutiveLosses}, Base: ₦${stakeAmount})`
                  );
                  publishLiveStatus({ currentStake, stakeMode });

                  // Attempt 1: Submit betslip placement and confirm via My Bets
                  let placeRes = await submitBetslipPlacement(engineFrame, page, currentStake, signal, clickedOdd);

                  // An uncertain click is reconciled from receipts, never submitted again here.

                  if (placeRes.placed) {
                    placedPickIds.add(String(signal.id));
                    if (signal._matchKey) placedRoundTeams.add(signal._matchKey);
                    if (weekNumber != null) lastPlacedWeek = Number(weekNumber);
                    logger.info('SportyBetExecutor', `✅ Confirmed Ticket #${placeRes.ticketId} for [${signal.home_team} vs ${signal.away_team} - ${signal.market} @ ${actualOdd} (₦${currentStake})]!`);
                    await syncSettledTicketsFromFrame(engineFrame);
                    await randomDelay(2000, 3500);
                  } else {
                    logger.warn('SportyBetExecutor', `Placement result: ${placeRes.reason}.`);
                    if (!pendingSubmission) await clearBetslipPhysically(engineFrame, page);
                    if (placeRes.reason === 'place_bet_disabled_or_expired') {
                      placedPickIds.add(String(signal.id));
                    }
                  }
                } else if (clickedOdd && String(clickedOdd.reason || '').startsWith('odd_locked_')) {
                  logger.info('SportyBetExecutor', `⏭️ Skipping locked/minimum odd (${clickedOdd.odd}) for [${signal.home_team} vs ${signal.away_team}]. Moving to next AI signal...`);
                  placedPickIds.add(String(signal.id));
                }
              }
            }
          } else if (iteration % 6 === 0) {
            // Subtle human idle mouse drift while waiting for next matchday
            await performHumanIdleGesture(page);
          }
        }

        publishLiveStatus();
        await randomDelay(4500, 6500);

      } catch (loopErr) {
        logger.warn('SportyBetExecutor', `Notice in execution loop: ${loopErr.message}`);
        await delay(5000);
      }
    }

  } catch (err) {
    logger.error('SportyBetExecutor', `Fatal error in SportyBet Executor: ${err.message}`);
    publishLiveStatus({ running: false, error: err.message });
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  isShuttingDown = true;
  publishLiveStatus({ running: false });
  process.exit(0);
});

process.on('SIGTERM', () => {
  isShuttingDown = true;
  publishLiveStatus({ running: false });
  process.exit(0);
});

startSportyBetExecutor();
