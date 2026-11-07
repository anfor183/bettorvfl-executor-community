import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  listDatabases: (dirPath) => ipcRenderer.invoke('list-databases', dirPath),
  queryDb: (dbPath, query, params) => ipcRenderer.invoke('query-db', dbPath, query, params),
  parseBettingStats: (dbPath) => ipcRenderer.invoke('parse-betting-stats', dbPath),
  getDbTables: (dbPath) => ipcRenderer.invoke('get-db-tables', dbPath),
  getDbInfo: (dbPath) => ipcRenderer.invoke('get-db-info', dbPath),
  askDbAiSql: (data) => ipcRenderer.invoke('ask-db-ai-sql', data),
  askDbAiExplain: (data) => ipcRenderer.invoke('ask-db-ai-explain', data),
  deleteDatabase: (dbPath) => ipcRenderer.invoke('delete-database', dbPath),
  dropTable: (dbPath, tableName) => ipcRenderer.invoke('drop-table', dbPath, tableName),
  readConfig: () => ipcRenderer.invoke('read-config'),
  writeConfig: (config) => ipcRenderer.invoke('write-config', config),
  readKeywords: (platform) => ipcRenderer.invoke('read-keywords', platform),
  writeKeywords: (data) => ipcRenderer.invoke('write-keywords', data),
  selectKeywordsFile: () => ipcRenderer.invoke('select-keywords-file'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectChromeFile: () => ipcRenderer.invoke('select-chrome-file'),
  selectCursorFile: () => ipcRenderer.invoke('select-cursor-file'),
  createNewUserDataDir: () => ipcRenderer.invoke('create-new-user-data-dir'),
  downloadChrome: () => ipcRenderer.invoke('download-chrome'),
  onChromeDownloadProgress: (callback) => {
    const subscription = (_, data) => callback(data)
    ipcRenderer.on('chrome-download-progress', subscription)
    return () => ipcRenderer.removeListener('chrome-download-progress', subscription)
  },
  startBot: (scriptName, options) => ipcRenderer.invoke('start-bot', scriptName, options),
  stopBot: () => ipcRenderer.invoke('stop-bot'),
  getBotStatus: () => ipcRenderer.invoke('get-bot-status'),
  clearBrowserData: () => ipcRenderer.invoke('clear-browser-data'),
  smartClearData: () => ipcRenderer.invoke('smart-clear-data'),
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  deleteProfile: (name, family) => ipcRenderer.invoke('delete-profile', name, family),
  deleteAllProfiles: () => ipcRenderer.invoke('delete-all-profiles'),
  getFamilies: () => ipcRenderer.invoke('get-families'),
  createFamily: (name) => ipcRenderer.invoke('create-family', name),
  renameFamily: (oldName, newName) => ipcRenderer.invoke('rename-family', oldName, newName),
  deleteFamily: (name) => ipcRenderer.invoke('delete-family', name),
  moveProfile: (profileId, oldFamily, newFamily) => ipcRenderer.invoke('move-profile', profileId, oldFamily, newFamily),
  createProfile: (profileName, familyName, options) => ipcRenderer.invoke('create-profile', profileName, familyName, options),
  updateProfileWebgl: (familyName, profileName, webglMode) => ipcRenderer.invoke('update-profile-webgl', familyName, profileName, webglMode),
  exportProfile: (profileName, familyName) => ipcRenderer.invoke('export-profile', profileName, familyName),
  exportFamily: (familyName) => ipcRenderer.invoke('export-family', familyName),
  importProfile: (familyName) => ipcRenderer.invoke('import-profile', familyName),
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),
  stopSpecificBot: (profilePath) => ipcRenderer.invoke('stop-specific-bot', profilePath),
  renameProfile: (oldName, newName, family) => ipcRenderer.invoke('rename-profile', oldName, newName, family),
  getProxies: () => ipcRenderer.invoke('get-proxies'),
  saveProxies: (proxies) => ipcRenderer.invoke('save-proxies', proxies),
  assignProxy: (data) => ipcRenderer.invoke('assign-proxy', data),
  getProfileProxy: (data) => ipcRenderer.invoke('get-profile-proxy', data),
  selectProxiesFile: () => ipcRenderer.invoke('select-proxies-file'),
  autoAssignProxies: () => ipcRenderer.invoke('auto-assign-proxies'),
  removeAllProxies: () => ipcRenderer.invoke('remove-all-proxies'),
  getProfileHistory: (data) => ipcRenderer.invoke('get-profile-history', data),
  clearProfileHistory: (data) => ipcRenderer.invoke('clear-profile-history', data),
  clearFamilyHistory: (familyName) => ipcRenderer.invoke('clear-family-history', familyName),
  clearAllHistories: () => ipcRenderer.invoke('clear-all-histories'),
  readPersonalities: () => ipcRenderer.invoke('read-personalities'),
  writePersonalities: (data) => ipcRenderer.invoke('write-personalities', data),
  askAiPersonality: (data) => ipcRenderer.invoke('ask-ai-personality', data),
  askAiSchedule: (data) => ipcRenderer.invoke('ask-ai-schedule', data),
  askAiRandomWeights: (data) => ipcRenderer.invoke('ask-ai-random-weights', data),
  askAiAdjustSettings: (data) => ipcRenderer.invoke('ask-ai-adjust-settings', data),
  googleDriveSync: (settings) => ipcRenderer.invoke('google-drive-sync', settings),
  googleDriveRestore: (settings) => ipcRenderer.invoke('google-drive-restore', settings),
  getGoogleDriveSettings: () => ipcRenderer.invoke('get-google-drive-settings'),
  saveGoogleDriveSettings: (settings) => ipcRenderer.invoke('save-google-drive-settings', settings),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  onBotLog: (callback) => ipcRenderer.on('bot-log', (_, data) => callback(data)),
  onBotStatus: (callback) => ipcRenderer.on('bot-status', (_, status) => callback(status)),
  removeLogListener: () => ipcRenderer.removeAllListeners('bot-log'),
  fetchWebshareProfile: (data) => ipcRenderer.invoke('fetch-webshare-profile', data),
  fetchWebshareStats: (data) => ipcRenderer.invoke('fetch-webshare-stats', data),
  fetchWebshareProxies: (data) => ipcRenderer.invoke('fetch-webshare-proxies', data),
  fetchDataimpulseBalance: (data) => ipcRenderer.invoke('fetch-dataimpulse-balance', data),
  generateDataimpulseProxies: (data) => ipcRenderer.invoke('generate-dataimpulse-proxies', data),
  getProfilesNetworkUsage: () => ipcRenderer.invoke('get-profiles-network-usage'),
  getNetworkSummary: () => ipcRenderer.invoke('get-network-summary'),
  setProfileNetworkLimits: (data) => ipcRenderer.invoke('set-profile-network-limits', data),
  clearProfileNetworkUsage: (data) => ipcRenderer.invoke('clear-profile-network-usage', data),
  clearAllProfilesNetworkUsage: (data) => ipcRenderer.invoke('clear-all-profiles-network-usage', data),
  clearGlobalNetworkUsage: (data) => ipcRenderer.invoke('clear-global-network-usage', data),
  exportBandwidthReport: () => ipcRenderer.invoke('export-bandwidth-report'),
  getBotSettings: () => ipcRenderer.invoke('get-bot-settings'),
  saveBotSettings: (data) => ipcRenderer.invoke('save-bot-settings', data),
  getPredictorTeams: (data) => ipcRenderer.invoke('get-predictor-teams', data),
  getTeamMatchups: (data) => ipcRenderer.invoke('get-team-matchups', data),
  predictMatchupAi: (data) => ipcRenderer.invoke('predict-matchup-ai', data),
  optimizeMlWeights: (data) => ipcRenderer.invoke('optimize-ml-weights', data),
  checkAiBalance: (data) => ipcRenderer.invoke('check-ai-balance', data),
  getBacktestSeasons: (data) => ipcRenderer.invoke('get-backtest-seasons', data),
  runBacktest: (data) => ipcRenderer.invoke('run-backtest', data),
  printBacktestPdf: (data) => ipcRenderer.invoke('print-backtest-pdf', data),
  analysePatterns: (data) => ipcRenderer.invoke('analyse-patterns', data),
  launchNewWindow: (data) => ipcRenderer.invoke('launch-new-window', data),
  scrapeLiveSeason: (data) => ipcRenderer.invoke('scrape-live-season', data),
  getLivePredictions: (data) => ipcRenderer.invoke('get-live-predictions', data),
  getVPSStatus: () => ipcRenderer.invoke('get-vps-status'),
  applyVPSOptimization: () => ipcRenderer.invoke('apply-vps-optimization'),
  reapZombieProcesses: () => ipcRenderer.invoke('reap-zombie-processes'),
  pruneVPSCache: () => ipcRenderer.invoke('prune-vps-cache'),
  saveVPSConfig: (settings) => ipcRenderer.invoke('save-vps-config', settings),
  // Predictor Betting Signals Collector
  getSignalCollectorState: () => ipcRenderer.invoke('get-signal-collector-state'),
  updateSignalCollectorConfig: (config) => ipcRenderer.invoke('update-signal-collector-config', config),
  connectSignalCollector: () => ipcRenderer.invoke('connect-signal-collector'),
  disconnectSignalCollector: () => ipcRenderer.invoke('disconnect-signal-collector'),
  testSignalServer: (data) => ipcRenderer.invoke('test-signal-server', data),
  clearCollectedSignals: () => ipcRenderer.invoke('clear-collected-signals'),
  exportCollectedSignals: (data) => ipcRenderer.invoke('export-collected-signals', data),
  onSignalCollectorStatus: (cb) => ipcRenderer.on('signal-collector-status', (_, data) => cb(data)),
  onSignalCollectorNewPicks: (cb) => ipcRenderer.on('signal-collector-new-picks', (_, data) => cb(data)),
  onSignalCollectorSettledPicks: (cb) => ipcRenderer.on('signal-collector-settled-picks', (_, data) => cb(data)),
  onSignalCollectorUpdate: (cb) => ipcRenderer.on('signal-collector-update', (_, data) => cb(data)),
  onSignalCollectorLog: (cb) => ipcRenderer.on('signal-collector-log', (_, data) => cb(data)),
  removeSignalCollectorListeners: () => {
    ipcRenderer.removeAllListeners('signal-collector-status');
    ipcRenderer.removeAllListeners('signal-collector-new-picks');
    ipcRenderer.removeAllListeners('signal-collector-settled-picks');
    ipcRenderer.removeAllListeners('signal-collector-update');
    ipcRenderer.removeAllListeners('signal-collector-log');
  },
  // 1xBet Bet Executor
  getBetExecutorConfig: () => ipcRenderer.invoke('get-bet-executor-config'),
  saveBetExecutorConfig: (config) => ipcRenderer.invoke('save-bet-executor-config', config),
  startBetExecutor: (options) => ipcRenderer.invoke('start-bet-executor', options),
  stopBetExecutor: () => ipcRenderer.invoke('stop-bet-executor'),
  getBetExecutorStatus: () => ipcRenderer.invoke('get-bet-executor-status'),
  getExecutorLiveStatus: () => ipcRenderer.invoke('get-executor-live-status'),
  onBetExecutorStatus: (cb) => ipcRenderer.on('bet-executor-status', (_, data) => cb(data)),
  onExecutorLiveStatus: (cb) => ipcRenderer.on('executor-live-status', (_, data) => cb(data)),
  onBetExecutorLog: (cb) => ipcRenderer.on('bet-executor-log', (_, data) => cb(data)),
  removeBetExecutorListeners: () => {
    ipcRenderer.removeAllListeners('bet-executor-status');
    ipcRenderer.removeAllListeners('executor-live-status');
    ipcRenderer.removeAllListeners('bet-executor-log');
  },
  // Logging System
  getExecutorLogs: (limit) => ipcRenderer.invoke('get-executor-logs', limit),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  clearSubsystemLogs: (sub) => ipcRenderer.invoke('clear-subsystem-logs', sub),
  getLogsDir: () => ipcRenderer.invoke('get-logs-dir'),
  // Live Monitor & Bet Tracker Database
  getTrackerBets: (limit, filterStatus) => ipcRenderer.invoke('get-tracker-bets', limit, filterStatus),
  getTrackerStats: () => ipcRenderer.invoke('get-tracker-stats'),
  getTrackerBalanceHistory: (limit) => ipcRenderer.invoke('get-tracker-balance-history', limit),
  exportTrackerBets: (format) => ipcRenderer.invoke('export-tracker-bets', format),
  syncTrackerBalance: (balance, currency) => ipcRenderer.invoke('sync-tracker-balance', balance, currency),
  clearTrackerStats: (options) => ipcRenderer.invoke('clear-tracker-stats', options),
  resetExecutorSessionStats: () => ipcRenderer.invoke('reset-executor-session-stats'),
  onProfilesUpdated: (cb) => {
    const s = () => cb();
    ipcRenderer.on('profiles-updated', s);
    return () => ipcRenderer.removeListener('profiles-updated', s);
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
