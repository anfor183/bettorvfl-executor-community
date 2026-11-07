import { createExecutorController } from '../../../utils/executor_control.mjs'
import { webBridge } from './web_bridge_server.js'
import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'

const originalIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function(channel, listener) {
  webBridge.registerHandler(channel, listener);
  return originalIpcHandle(channel, listener);
};
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import fs from 'fs'
import path from 'path'
import { spawn, exec } from 'child_process'
import os from 'os'
import util from 'util'
import https from 'https'
import { runSync, runRestore } from './google_sync.js'
import icon from '../../resources/icon.png?asset'
import { createRequire } from 'module'
const nodeRequire = createRequire(import.meta.url)

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox')
}

function getVPSEngine() {
  try {
    const candidates = [
      resolveAppPath('utils/vps_engine.js'),
      path.resolve(process.cwd(), 'utils/vps_engine.js'),
      path.resolve(process.cwd(), '../utils/vps_engine.js'),
      path.resolve(__dirname, '../../../utils/vps_engine.js'),
      path.resolve(__dirname, '../../../../utils/vps_engine.js')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return nodeRequire(p);
      }
    }
    console.warn('[VPS Engine] utils/vps_engine.js not found in candidate paths:', candidates);
    return null;
  } catch (e) {
    console.error('[VPS Engine] Error requiring VPS Engine module:', e);
    return null;
  }
}

function getSignalCollector() {
  try {
    const candidates = [
      resolveAppPath('utils/signal_collector.js'),
      path.resolve(process.cwd(), 'utils/signal_collector.js'),
      path.resolve(process.cwd(), '../utils/signal_collector.js'),
      path.resolve(__dirname, '../../../utils/signal_collector.js'),
      path.resolve(__dirname, '../../../../utils/signal_collector.js')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return nodeRequire(p).signalCollector;
      }
    }
    console.warn('[Signal Collector] utils/signal_collector.js not found in candidate paths:', candidates);
    return null;
  } catch (e) {
    console.error('[Signal Collector] Error requiring Signal Collector module:', e);
    return null;
  }
}

function getLogger() {
  try {
    const candidates = [
      resolveAppPath('utils/logger.js'),
      path.resolve(process.cwd(), 'utils/logger.js'),
      path.resolve(process.cwd(), '../utils/logger.js'),
      path.resolve(__dirname, '../../../utils/logger.js'),
      path.resolve(__dirname, '../../../../utils/logger.js')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return nodeRequire(p);
      }
    }
    console.warn('[Logger] utils/logger.js not found in candidate paths:', candidates);
    return null;
  } catch (e) {
    console.error('[Logger] Error requiring Logger module:', e);
    return null;
  }
}

function getTrackerDB() {
  try {
    const candidates = [
      resolveAppPath('utils/db.js'),
      path.resolve(process.cwd(), 'utils/db.js'),
      path.resolve(process.cwd(), '../utils/db.js'),
      path.resolve(__dirname, '../../../utils/db.js'),
      path.resolve(__dirname, '../../../../utils/db.js')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return nodeRequire(p);
      }
    }
    console.warn('[Tracker DB] utils/db.js not found in candidate paths:', candidates);
    return null;
  } catch (e) {
    console.error('[Tracker DB] Error requiring DB module:', e);
    return null;
  }
}

function resolveAppPath(relativePath = '') {
  if (!relativePath) {
    if (app.isPackaged) return path.join(process.resourcesPath, 'app-scripts');
    return path.resolve(__dirname, '../../../');
  }
  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app-scripts', relativePath);
  }
  return path.resolve(__dirname, '../../../', relativePath);
}

function resolveDataDir(dirPath) {
  const defaultLocalDir = resolveAppPath('Virtual FootBall Data');
  if (!dirPath) {
    return defaultLocalDir;
  }
  if (path.isAbsolute(dirPath)) {
    if (fs.existsSync(dirPath)) return dirPath;
    return defaultLocalDir;
  }
  return resolveAppPath(dirPath);
}

function resolveDbPath(dbPath) {
  if (!dbPath) return '';
  if (path.isAbsolute(dbPath) && fs.existsSync(dbPath)) return dbPath;
  const localCandidate = resolveAppPath(dbPath);
  if (fs.existsSync(localCandidate)) return localCandidate;
  const inDataDir = path.join(resolveDataDir(''), path.basename(dbPath));
  if (fs.existsSync(inDataDir)) return inDataDir;
  return dbPath;
}

function safeIsDirectory(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
    }
    return stat.isDirectory();
  } catch (e) {
    return false;
  }
}


function spawnNode(scriptPath, args, options = {}) {
  const binaryPath = app.isPackaged ? process.execPath : 'node';
  const baseEnv = app.isPackaged ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;
  
  return spawn(binaryPath, [scriptPath, ...args], {
    cwd: options.cwd || path.dirname(scriptPath),
    env: { ...baseEnv, ...options.env },
    ...options
  });
}

function parseJSONFromStdout(output) {
  const lines = output.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if ((line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))) {
      try {
        return JSON.parse(line)
      } catch (e) {}
    }
  }
  throw new Error('No valid JSON object or array found in output')
}

function runMLPredict(dbPath, homeTeam, awayTeam) {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const child = spawnNode(runnerPath, ['predict', dbPath, homeTeam, awayTeam])
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput && !output) {
          resolve({ success: false, error: errorOutput })
        } else {
          resolve(parseJSONFromStdout(output))
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse ML predictor output: ' + e.message })
      }
    })
  })
}

function runMLOptimize(dbPath) {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const child = spawnNode(runnerPath, ['optimize', dbPath])
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput && !output) {
          resolve({ success: false, error: errorOutput })
        } else {
          resolve(parseJSONFromStdout(output))
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse ML optimizer output: ' + e.message })
      }
    })
  })
}

function runMLBacktest(dbPath, seasonName) {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    // Season names may contain spaces – pass as separate argv tokens; runner joins them
    const child = spawnNode(runnerPath, ['backtest', dbPath, ...seasonName.split(' ')])
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput && !output) {
          resolve({ success: false, error: errorOutput })
        } else {
          resolve(parseJSONFromStdout(output))
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse ML backtest output: ' + e.message })
      }
    })
  })
}

function runMLAnalysePatterns(dbPath) {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const child = spawnNode(runnerPath, ['analyse-patterns', dbPath])
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput && !output) {
          resolve({ success: false, error: errorOutput })
        } else {
          resolve(parseJSONFromStdout(output))
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse pattern analysis output: ' + e.message })
      }
    })
  })
}

function runMLScrapeLiveSeason(dbPath, isHeadless) {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const child = spawnNode(runnerPath, ['scrape-live-season', dbPath, isHeadless ? 'true' : 'false'])
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput && !output) {
          resolve({ success: false, error: errorOutput })
        } else {
          resolve(parseJSONFromStdout(output))
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse live scraper output: ' + e.message })
      }
    })
  })
}

function runMLGetLivePredictions(dbPath) {
  return new Promise((resolve) => {
    const runnerPath = resolveAppPath('utils/ml_runner.js')
    let output = ''
    let errorOutput = ''
    const child = spawnNode(runnerPath, ['get-live-predictions', dbPath])
    child.stdout.on('data', (data) => { output += data.toString() })
    child.stderr.on('data', (data) => { errorOutput += data.toString() })
    child.on('close', (code) => {
      try {
        if (code !== 0 && errorOutput && !output) {
          resolve({ success: false, error: errorOutput })
        } else {
          resolve(parseJSONFromStdout(output))
        }
      } catch (e) {
        resolve({ success: false, error: 'Failed to parse get-live-predictions output: ' + e.message })
      }
    })
  })
}

const execPromise = util.promisify(exec)

const activeWindows = new Set()

function broadcastToWindows(channel, payload) {
  for (const win of activeWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
  webBridge.broadcast(channel, payload)
}

function createWindow(options = {}) {
  console.log('Creating window with options:', options)
  const preloadMjs = join(__dirname, '../preload/index.mjs')
  const preloadJs = join(__dirname, '../preload/index.js')
  const preloadCjs = join(__dirname, '../preload/index.cjs')
  const finalPreload = fs.existsSync(preloadMjs) ? preloadMjs : (fs.existsSync(preloadJs) ? preloadJs : preloadCjs)

  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    show: true,
    autoHideMenuBar: true,
    icon: icon,
    webPreferences: {
      preload: finalPreload,
      sandbox: false,
      contextIsolation: true
    }
  })

  activeWindows.add(win)

  win.on('closed', () => {
    activeWindows.delete(win)
  })

  win.webContents.on('console-message', (_, level, message, line, sourceId) => {
    console.log(`[Renderer Console L${level}] ${message} (${sourceId}:${line})`)
  })

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`Failed to load: ${errorCode} - ${errorDescription}`)
  })

  win.webContents.on('did-finish-load', () => {
    console.log('Renderer content loaded successfully')
  })

  win.on('ready-to-show', () => {
    console.log('Window ready to show event fired')
    win.show()
    win.focus()
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const queryParams = []
  if (options.theme) queryParams.push(`theme=${options.theme}`)
  if (options.palette) queryParams.push(`palette=${options.palette}`)
  const queryStr = queryParams.length > 0 ? `?${queryParams.join('&')}` : ''

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + queryStr)
  } else {
    const fileOptions = {}
    if (options.theme || options.palette) {
      fileOptions.query = {}
      if (options.theme) fileOptions.query.theme = options.theme
      if (options.palette) fileOptions.query.palette = options.palette
    }
    win.loadFile(join(__dirname, '../renderer/index.html'), fileOptions)
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.nexus.panel')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // --- IPC Handlers ---

  const CONFIG_PATH = resolveAppPath('browser-config.json')
  const KEYWORDS_PATH = resolveAppPath('keywords.txt')
  const PROXIES_PATH = resolveAppPath('proxies.json')
  const PROFILES_BASE_DIR = resolveAppPath('profiles')
  const PERSONALITIES_PATH = resolveAppPath('personalities.json')

  ipcMain.handle('read-config', async () => {
    try {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8')
      return JSON.parse(data)
    } catch (error) {
      console.error('Error reading config:', error)
      return null
    }
  })

  ipcMain.handle('list-databases', async (_, dirPath) => {
    try {
      const resolved = resolveDataDir(dirPath)
      if (!fs.existsSync(resolved)) {
        try { fs.mkdirSync(resolved, { recursive: true }) } catch (e) {}
        return []
      }
      return fs.readdirSync(resolved).filter(f => f.endsWith('.db') || f.endsWith('.sqlite'))
    } catch (error) {
      console.error('Error listing databases:', error)
      return []
    }
  })

  ipcMain.handle('query-db', async (event, dbPath, query, params = []) => {
    return new Promise((resolve) => {
      const readerPath = resolveAppPath('db_reader.js')
      const targetDb = resolveDbPath(dbPath)
      let output = ''
      let errorOutput = ''
      
      const child = spawnNode(readerPath, [targetDb, query, JSON.stringify(params)])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        try {
          if (errorOutput && !output) {
            const errJson = JSON.parse(errorOutput)
            resolve({ success: false, error: errJson.error })
          } else {
            const result = JSON.parse(output)
            resolve(result)
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to parse database output: ' + e.message })
        }
      })
    })
  })

  ipcMain.handle('parse-betting-stats', async (event, dbPath) => {
    return new Promise((resolve) => {
      const parserPath = resolveAppPath('db_parser.js')
      let output = ''
      let errorOutput = ''
      
      const child = spawnNode(parserPath, [dbPath])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        try {
          if (code !== 0 && errorOutput && !output) {
            const match = errorOutput.match(/\{[\s\S]*\}/)
            const errJson = JSON.parse(match ? match[0] : errorOutput)
            resolve({ success: false, error: errJson.error || errorOutput })
          } else {
            const match = output.match(/\{[\s\S]*\}/)
            if (!match) {
              throw new Error('No JSON output found in process stdout: ' + output)
            }
            const result = JSON.parse(match[0])
            if (result && result.success) {
              runMLOptimize(dbPath)
                .then(() => console.log("Successfully auto-optimized ML weights after parsing new stats."))
                .catch(optimizeErr => console.error("Auto-optimize weights failed:", optimizeErr.message))
            }
            resolve(result)
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to parse database output: ' + e.message })
        }
      })
    })
  })

  ipcMain.handle('get-db-tables', async (event, dbPath) => {
    return new Promise((resolve) => {
      const readerPath = resolveAppPath('db_reader.js')
      let output = ''
      let errorOutput = ''
      
      const child = spawnNode(readerPath, [dbPath, "SELECT name FROM sqlite_master WHERE type='table'"])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        try {
          if (errorOutput && !output) {
            resolve({ success: false, error: JSON.parse(errorOutput).error })
          } else {
            const result = JSON.parse(output)
            if (result.success) {
               resolve({ success: true, tables: result.data.map(r => r.name) })
            } else {
               resolve({ success: false, error: result.error })
            }
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to parse tables: ' + e.message })
        }
      })
    })
  })

  ipcMain.handle('get-db-info', async (event, dbPath) => {
    return new Promise((resolve) => {
      const readerPath = resolveAppPath('db_reader.js')
      let output = ''
      let errorOutput = ''
      
      const child = spawnNode(readerPath, [dbPath, '__INFO__'])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        try {
          if (errorOutput && !output) {
            resolve({ success: false, error: JSON.parse(errorOutput).error })
          } else {
            resolve(JSON.parse(output))
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to parse database info: ' + e.message })
        }
      })
    })
  })

  async function callAI({ provider, apiKey, systemPrompt, userPrompt, temperature = 0.7 }) {
    if (!apiKey) {
      throw new Error(`API key is missing for provider "${provider}". Please set it in Settings.`);
    }

    const prov = (provider || 'deepseek').toLowerCase();

    if (prov === 'deepseek' || prov === 'openai' || prov === 'gemini') {
      let url = 'https://api.deepseek.com/v1/chat/completions';
      let model = 'deepseek-chat';

      if (prov === 'openai') {
        url = 'https://api.openai.com/v1/chat/completions';
        model = 'gpt-4o-mini';
      } else if (prov === 'gemini') {
        url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
        model = 'gemini-2.5-flash';
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: temperature
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`AI API Error (${prov}): ${response.statusText}. ${errText}`);
      }

      const data = await response.json();
      return data.choices[0].message.content.trim();
    }

    if (prov === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-latest',
          max_tokens: 2048,
          system: systemPrompt,
          messages: [
            { role: 'user', content: userPrompt }
          ],
          temperature: temperature
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`AI API Error (Anthropic): ${response.statusText}. ${errText}`);
      }

      const data = await response.json();
      if (data.content && data.content[0] && data.content[0].text) {
        return data.content[0].text.trim();
      }
      throw new Error('Invalid response structure from Anthropic API');
    }

    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  ipcMain.handle('ask-db-ai-sql', async (_, { question, schema, provider, apiKey }) => {
    try {
      const systemPrompt = "You are a SQLite database expert. Write a single SQLite SELECT query to answer the user's question. Return ONLY the raw SQL query. No markdown, no explanation, no backticks. Only SELECT queries are allowed. Ensure any table and column names used match the schema exactly.";
      const userPrompt = `Database Schema:\n${schema}\n\nUser Question: ${question}`;
      
      let sql = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.1 });
      sql = sql.replace(/```sql|```/g, '').trim();
      return { success: true, sql };
    } catch (e) {
      console.error('Database AI SQL Error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('ask-db-ai-explain', async (_, { question, sql, result, provider, apiKey }) => {
    try {
      const systemPrompt = "You are a friendly and helpful AI data analyst. Answer the user's question based on the SQLite query executed and its result. Write a concise, friendly natural language response explaining the answer. Keep it directly relevant and precise.";
      const userPrompt = `User Question: ${question}\nSQL Query Executed: ${sql}\nQuery Result (JSON): ${JSON.stringify(result)}`;
      
      const answer = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.5 });
      return { success: true, answer };
    } catch (e) {
      console.error('Database AI Explain Error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('delete-database', async (event, dbPath) => {
    try {
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath)
        return { success: true }
      }
      return { success: false, error: 'Database not found' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('drop-table', async (event, dbPath, tableName) => {
    return new Promise((resolve) => {
      const readerPath = resolveAppPath('db_reader.js')
      let output = ''
      let errorOutput = ''
      
      const child = spawnNode(readerPath, [dbPath, `DROP TABLE IF EXISTS ${tableName}`, '[]'])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        try {
          if (errorOutput && !output) {
            resolve({ success: false, error: JSON.parse(errorOutput).error })
          } else {
            resolve(JSON.parse(output))
          }
        } catch (e) {
          resolve({ success: false, error: e.message })
        }
      })
    })
  })

  ipcMain.handle('write-config', async (_, config) => {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8')
      return { success: true }
    } catch (error) {
      console.error('Error writing config:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('read-keywords', async (_, platform = 'google') => {
    try {
      const pPath = resolveAppPath(`keywords_${platform}.txt`)
      if (fs.existsSync(pPath)) {
        return fs.readFileSync(pPath, 'utf8')
      }
      return ''
    } catch (error) {
      console.error(`Error reading keywords for ${platform}:`, error)
      return ''
    }
  })

  ipcMain.handle('write-keywords', async (_, { content, platform = 'google' }) => {
    try {
      const pPath = resolveAppPath(`keywords_${platform}.txt`)
      fs.writeFileSync(pPath, content, 'utf8')
      return { success: true }
    } catch (error) {
      console.error(`Error writing keywords for ${platform}:`, error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('select-keywords-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    })

    if (!result.canceled && result.filePaths.length > 0) {
      const content = fs.readFileSync(result.filePaths[0], 'utf8')
      return { success: true, content }
    }
    return { success: false }
  })

  ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, path: result.filePaths[0] }
    }
    return { success: false }
  })



  ipcMain.handle('get-bot-settings', async () => {
    try {
      const p = resolveAppPath('bot_settings.json')
      if (fs.existsSync(p)) {
        const settings = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (settings.outputDir) {
          settings.outputDir = resolveDataDir(settings.outputDir)
        } else {
          settings.outputDir = resolveAppPath('Virtual FootBall Data')
        }
        return settings
      }
      return { outputDir: resolveAppPath('Virtual FootBall Data') }
    } catch (e) {
      return { outputDir: resolveAppPath('Virtual FootBall Data') }
    }
  })

  ipcMain.handle('save-bot-settings', async (_, data) => {
    try {
      const p = resolveAppPath('bot_settings.json')
      fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('select-chrome-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Executables', extensions: ['exe'] }]
    })

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, path: result.filePaths[0] }
    }
    return { success: false }
  })

  ipcMain.handle('select-cursor-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'ico'] }]
    })

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, path: result.filePaths[0] }
    }
    return { success: false }
  })

  ipcMain.handle('create-new-user-data-dir', async (event) => {
    try {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: 'Select Folder to Save the New User Data Directory',
        properties: ['openDirectory', 'createDirectory']
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'User cancelled folder selection' }
      }

      const parentDir = result.filePaths[0]
      let newDirName = 'my-bot-profiles'
      let targetPath = path.join(parentDir, newDirName)
      
      let counter = 1
      while (fs.existsSync(targetPath)) {
        newDirName = `my-bot-profiles-${counter}`
        targetPath = path.join(parentDir, newDirName)
        counter++
      }

      fs.mkdirSync(targetPath, { recursive: true })
      return { success: true, path: targetPath }
    } catch (e) {
      console.error('[Create User Data Dir Error]', e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('download-chrome', async (event) => {
    const sendProgress = (stage, message, percent = 0) => {
      const payload = { stage, message, percent }
      if (event && event.sender) {
        event.sender.send('chrome-download-progress', payload)
      } else {
        broadcastToWindows('chrome-download-progress', payload)
      }
    }

    try {
      sendProgress('fetching', 'Checking latest stable Chrome for Testing release...', 10)
      
      const json = await new Promise((resolve, reject) => {
        https.get('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json', (res) => {
          let data = ''
          res.on('data', chunk => data += chunk)
          res.on('end', () => {
            try {
              resolve(JSON.parse(data))
            } catch (e) {
              reject(new Error('Failed to parse Chrome versions JSON'))
            }
          })
        }).on('error', reject)
      })

      // Detect platform: win64, win32, linux64, mac-x64, mac-arm64
      let platformKey = 'linux64'
      if (process.platform === 'win32') {
        platformKey = process.arch === 'ia32' ? 'win32' : 'win64'
      } else if (process.platform === 'darwin') {
        platformKey = process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
      } else {
        platformKey = 'linux64'
      }

      const stableChannel = json?.channels?.Stable
      if (!stableChannel) throw new Error('Stable release channel not found in Chrome metadata')
      
      const version = stableChannel.version
      const chromeDownloads = stableChannel.downloads?.chrome || []
      const platformDownload = chromeDownloads.find(d => d.platform === platformKey) || chromeDownloads.find(d => d.platform.startsWith(process.platform === 'win32' ? 'win' : (process.platform === 'darwin' ? 'mac' : 'linux')))
      if (!platformDownload) throw new Error(`${platformKey} platform download not found in Chrome metadata`)
      
      const zipUrl = platformDownload.url
      sendProgress('fetching', `Found Chrome version ${version} (${platformKey}). Preparing directory...`, 20)

      const rootDir = resolveAppPath('')
      const chromeParentDir = path.join(rootDir, 'chrome')
      if (!fs.existsSync(chromeParentDir)) {
        fs.mkdirSync(chromeParentDir, { recursive: true })
      }

      const versionFolder = `${platformKey}-${version}`
      const targetFolder = path.join(chromeParentDir, versionFolder)
      
      let exeRelative = path.join(`chrome-${platformKey}`, 'chrome')
      if (process.platform === 'win32') {
        exeRelative = path.join(`chrome-${platformKey}`, 'chrome.exe')
      } else if (process.platform === 'darwin') {
        exeRelative = path.join(`chrome-${platformKey}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      }
      let expectedExe = path.join(targetFolder, exeRelative)

      if (fs.existsSync(expectedExe)) {
        if (process.platform !== 'win32') {
          try { fs.chmodSync(expectedExe, 0o755) } catch (e) {}
        }
        if (fs.existsSync(CONFIG_PATH)) {
          try {
            const browserConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
            if (browserConfig.paths) {
              browserConfig.paths.chrome = expectedExe
              fs.writeFileSync(CONFIG_PATH, JSON.stringify(browserConfig, null, 4), 'utf8')
            }
          } catch (err) {}
        }
        sendProgress('completed', `Chrome version ${version} is already installed!`, 100)
        return { success: true, alreadyExists: true, path: expectedExe, version }
      }

      const zipPath = path.join(chromeParentDir, `chrome-${platformKey}-${version}.zip`)
      sendProgress('downloading', `Downloading Chrome for Testing (${platformKey}) v${version}...`, 30)

      await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(zipPath)
        https.get(zipUrl, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Failed to download: Status Code ${res.statusCode}`))
            return
          }
          
          const totalSize = parseInt(res.headers['content-length'] || '0', 10)
          let downloaded = 0
          
          res.on('data', (chunk) => {
            downloaded += chunk.length
            fileStream.write(chunk)
            if (totalSize > 0) {
              const percent = Math.floor(30 + (downloaded / totalSize) * 45)
              sendProgress('downloading', `Downloading: ${Math.floor(downloaded / 1024 / 1024)}MB / ${Math.floor(totalSize / 1024 / 1024)}MB`, percent)
            }
          })
          
          res.on('end', () => {
            fileStream.end()
            resolve()
          })
        }).on('error', (err) => {
          fileStream.destroy()
          if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath)
          reject(err)
        })
      })

      sendProgress('extracting', 'Extracting Chrome archive...', 80)
      if (!fs.existsSync(targetFolder)) {
        fs.mkdirSync(targetFolder, { recursive: true })
      }

      if (process.platform === 'win32') {
        try {
          await execPromise(`tar -xf "${zipPath}" -C "${targetFolder}"`)
        } catch (tarErr) {
          const powershellCmd = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${targetFolder}' -Force"`
          await execPromise(powershellCmd)
        }
      } else {
        await execPromise(`unzip -o -q "${zipPath}" -d "${targetFolder}"`)
      }

      sendProgress('cleanup', 'Cleaning up temporary download files...', 95)
      if (fs.existsSync(zipPath)) {
        try {
          fs.unlinkSync(zipPath)
        } catch (e) {}
      }

      if (process.platform !== 'win32' && fs.existsSync(expectedExe)) {
        try {
          fs.chmodSync(expectedExe, 0o755)
        } catch (chmodErr) {
          console.warn('Failed to set chmod on Chrome binary:', chmodErr)
        }
      }

      if (!fs.existsSync(expectedExe)) {
        // Fallback: search for chrome binary in targetFolder
        const exeName = process.platform === 'win32' ? 'chrome.exe' : 'chrome'
        try {
          const files = fs.readdirSync(targetFolder, { recursive: true })
          const found = files.find(f => typeof f === 'string' && (f.endsWith(path.sep + exeName) || f === exeName))
          if (found) {
            expectedExe = path.join(targetFolder, found)
            if (process.platform !== 'win32') {
              try { fs.chmodSync(expectedExe, 0o755) } catch (e) {}
            }
          }
        } catch (searchErr) {}
      }

      if (!fs.existsSync(expectedExe)) {
        throw new Error(`Chrome executable was not found in ${targetFolder}`)
      }

      if (fs.existsSync(CONFIG_PATH)) {
        const browserConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
        if (browserConfig.paths) {
          browserConfig.paths.chrome = expectedExe
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(browserConfig, null, 4), 'utf8')
        }
      }

      sendProgress('completed', `Chrome version ${version} downloaded and updated successfully!`, 100)
      return { success: true, path: expectedExe, version }

    } catch (e) {
      console.error('[Chrome Auto-Updater Error]', e)
      sendProgress('failed', `Error: ${e.message}`, 0)
      return { success: false, error: e.message }
    }
  })

  let botProcesses = []
  let schedulerQueue = []
  let lastRunTimes = {}
  let schedulerTickTimer = null
  let manualQueue = []

  function executeBotInstance(scriptName, profileId, family, device, browser = 'random', eventSender = null) {
    let scriptPath = resolveAppPath(scriptName)
    if (!fs.existsSync(scriptPath)) {
      if (fs.existsSync(resolveAppPath('test.js'))) {
        scriptPath = resolveAppPath('test.js');
      }
    }
    const profilePath = path.join(PROFILES_BASE_DIR, family, profileId)

    const win = eventSender ? BrowserWindow.fromWebContents(eventSender) : null
    const winId = win ? win.id : 'scheduler'

    // Ensure directory exists
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true })
      broadcastToWindows('profiles-updated')
    }

    let headless = true
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
        if (cfg.scheduler && cfg.scheduler.headless !== undefined) {
          headless = cfg.scheduler.headless
        }
      }
    } catch (e) {
      console.error('Error reading scheduler headless config:', e.message)
    }

    console.log(`[Scheduler Engine] Launching bot for profile: ${profilePath}`)
    const startMsg = `[Scheduler] Starting scheduled task "${scriptName}" for profile "${profileId}"...`
    if (eventSender) {
      eventSender.send('bot-log', startMsg)
    } else {
      broadcastToWindows('bot-log', startMsg)
    }

    const child = spawnNode(scriptPath, [`--user-data-dir=${profilePath}`, `--device=${device}`, `--browser=${browser}`, `--headless=${headless}`])

    const botInfo = {
      id: botProcesses.length,
      process: child,
      profilePath,
      profileType: 'permanent',
      startTime: new Date().toISOString(),
      isScheduler: true,
      winId
    }
    botProcesses.push(botInfo)

    const botIndex = botProcesses.length
    
    const pipeLogs = (data, isError = false) => {
      const msg = `[Scheduler - Profile ${profileId}] ${isError ? 'ERROR: ' : ''}${data.toString()}`
      if (eventSender) {
        eventSender.send('bot-log', msg)
      } else {
        broadcastToWindows('bot-log', msg)
      }
    }

    child.stdout.on('data', (data) => pipeLogs(data, false))
    child.stderr.on('data', (data) => pipeLogs(data, true))

    child.on('close', (code) => {
      const endMsg = `[Scheduler - Profile ${profileId}] Process exited with code ${code}`
      if (eventSender) {
        eventSender.send('bot-log', endMsg)
      } else {
        broadcastToWindows('bot-log', endMsg)
      }

      botProcesses = botProcesses.filter(p => p.process !== child)
      
      const statusMsg = getCurrentBotStatus(winId)
      if (eventSender) {
        eventSender.send('bot-status', statusMsg)
      } else {
        broadcastToWindows('bot-status', statusMsg)
      }

      // A slot has opened! Trigger the queue check
      processSchedulerQueue(eventSender)
      processManualQueue()
    })

    const statusMsg = getCurrentBotStatus()
    if (eventSender) {
      eventSender.send('bot-status', statusMsg)
    } else {
      broadcastToWindows('bot-status', statusMsg)
    }
  }

  function processSchedulerQueue(eventSender = null) {
    if (schedulerQueue.length === 0) return

    if (!fs.existsSync(CONFIG_PATH)) return
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    const maxConcurrent = config.scheduler?.maxConcurrentProfiles ?? 2

    while (botProcesses.length < maxConcurrent && schedulerQueue.length > 0) {
      const nextTask = schedulerQueue.shift()
      console.log(`[Scheduler Queue] Slot available! Launching queued task for profile "${nextTask.profileId}"`)
      
      const msg = `[Scheduler] Slot available! Spawning queued profile "${nextTask.profileId}"`
      if (eventSender) {
        eventSender.send('bot-log', msg)
      } else {
        broadcastToWindows('bot-log', msg)
      }
      
      executeBotInstance(nextTask.scriptName, nextTask.profileId, nextTask.family, nextTask.device, nextTask.browser || 'random', eventSender)
    }
  }

  function spawnManualTask(task) {
    const { scriptPath, profilePath, profileType, device, browser, headless, sender, botIndex, winId } = task

    // Ensure directory exists
    if (!fs.existsSync(profilePath)) {
      fs.mkdirSync(profilePath, { recursive: true })
    }

    console.log(`[Manual Queue] Spawning profile: ${profilePath} (WebGL: ${task.webglMode || 'generated'})`)
    sender.send('bot-log', `[Launcher] Spawning queued profile "${path.basename(profilePath)}" (Index ${botIndex}, WebGL: ${task.webglMode || 'generated'})...`)

    const child = spawnNode(scriptPath, [
      `--user-data-dir=${profilePath}`,
      `--device=${device}`,
      `--browser=${browser}`,
      `--headless=${headless}`,
      `--webgl=${task.webglMode || 'generated'}`
    ])

    const botInfo = {
      id: botIndex - 1,
      process: child,
      profilePath,
      profileType,
      startTime: new Date().toISOString(),
      isManual: true,
      winId
    }
    botProcesses.push(botInfo)

    child.stdout.on('data', (data) => {
      sender.send('bot-log', `[Bot ${botIndex}] ${data.toString()}`)
    })

    child.stderr.on('data', (data) => {
      sender.send('bot-log', `[Bot ${botIndex}] ERROR: ${data.toString()}`)
    })

    child.on('close', (code) => {
      sender.send('bot-log', `[Bot ${botIndex}] Process exited with code ${code}`)

      // Cleanup temporary profiles
      if (profileType === 'temporary' && fs.existsSync(profilePath)) {
        try {
          fs.rmSync(profilePath, { recursive: true, force: true })
        } catch (e) {
          console.warn(`Failed to cleanup temp profile: ${profilePath}`, e.message)
        }
      }

      botProcesses = botProcesses.filter(p => p.process !== child)
      sender.send('bot-status', getCurrentBotStatus(winId))

      // Trigger next task in queues
      processSchedulerQueue(sender)
      processManualQueue()
    })

    sender.send('bot-status', getCurrentBotStatus(winId))
  }

  function processManualQueue() {
    if (manualQueue.length === 0) return

    console.log(`[Manual Queue Status] Total Queued: ${manualQueue.length}`)

    // Process manual tasks dynamically based on individual window limits
    let processedAny = true;
    while (processedAny && manualQueue.length > 0) {
      processedAny = false;
      const nextTaskIndex = manualQueue.findIndex(task => {
        const limit = task.concurrencyLimit || 3;
        const runningCount = botProcesses.filter(p => p.isManual && p.winId === task.winId).length;
        return runningCount < limit;
      });

      if (nextTaskIndex !== -1) {
        const task = manualQueue.splice(nextTaskIndex, 1)[0];
        spawnManualTask(task);
        processedAny = true;
      }
    }
  }

  function resolveScriptForTask(taskName, schedulerSettings = {}) {
    const lower = taskName.toLowerCase()
    
    // Custom Channel Journey
    if (lower.includes('custom channel') || lower.includes('channel journey') || lower.includes('channel watch')) {
      return schedulerSettings.youtubeChannelScript || 'youtube_custom_channel_journey.js'
    }
    
    // Custom Playlist Journey
    if (lower.includes('custom playlist') || lower.includes('playlist journey') || lower.includes('playlist watch') || lower.includes('playlist play')) {
      return schedulerSettings.youtubePlaylistScript || 'youtube_custom_playlist_journey.js'
    }
    
    // Targeted Search Journey
    if (lower.includes('target search') || lower.includes('targeted search') || lower.includes('target watch') || lower.includes('targeted watch')) {
      return schedulerSettings.youtubeTargetScript || 'youtube_target_search.js'
    }
    
    // Standard YouTube Watch/Search
    if (lower.includes('youtube') || lower.includes('video') || lower.includes('watch')) {
      return schedulerSettings.youtubeScript || 'human_youtube_search.js'
    }
    
    // Gmail / Email
    if (lower.includes('gmail') || lower.includes('email') || lower.includes('inbox') || lower.includes('newsletter') || lower.includes('spam')) {
      return schedulerSettings.gmailScript || 'human_gmail_journey.js'
    }
    
    // Articles / Portal
    if (lower.includes('article') || lower.includes('portal') || lower.includes('browse') || lower.includes('blog') || lower.includes('news')) {
      return schedulerSettings.articleScript || 'human_article_search.js'
    }
    
    // Virtual Football Archive
    if (lower.includes('virtual football') || lower.includes('archive scraper')) {
      return 'human_virtual_football_archive.js'
    }

    // Custom Website & Ad Journey (must come before generic website check)
    if (lower.includes('custom website') || lower.includes('ad journey') || lower.includes('monetize') || lower.includes('custom visit') || lower.includes('custom web')) {
      return schedulerSettings.customWebsiteScript || 'human_custom_website_journey.js'
    }
    
    // Website / Personality
    if (lower.includes('website') || lower.includes('visit') || lower.includes('personality')) {
      return schedulerSettings.websiteScript || 'human_website_visit.js'
    }
    
    return schedulerSettings.googleScript || 'human_google_search.js'
  }

  function isTaskTypeEnabled(taskName, schedulerSettings = {}) {
    const lower = taskName.toLowerCase()
    if (lower.includes('custom channel') || lower.includes('channel journey') || lower.includes('channel watch')) {
      return schedulerSettings.youtubeChannelEnabled !== false
    }
    if (lower.includes('custom playlist') || lower.includes('playlist journey') || lower.includes('playlist watch') || lower.includes('playlist play')) {
      return schedulerSettings.youtubePlaylistEnabled !== false
    }
    if (lower.includes('target search') || lower.includes('targeted search') || lower.includes('target watch') || lower.includes('targeted watch')) {
      return schedulerSettings.youtubeTargetEnabled !== false
    }
    if (lower.includes('youtube') || lower.includes('video') || lower.includes('watch')) {
      return schedulerSettings.youtubeEnabled !== false
    }
    if (lower.includes('gmail') || lower.includes('email') || lower.includes('inbox') || lower.includes('newsletter') || lower.includes('spam')) {
      return schedulerSettings.gmailEnabled !== false
    }
    if (lower.includes('article') || lower.includes('portal') || lower.includes('browse') || lower.includes('blog') || lower.includes('news')) {
      return schedulerSettings.articleEnabled !== false
    }
    if (lower.includes('virtual football') || lower.includes('archive scraper')) {
      return schedulerSettings.virtualFootballEnabled !== false
    }
    if (lower.includes('custom website') || lower.includes('ad journey') || lower.includes('monetize') || lower.includes('custom visit') || lower.includes('custom web')) {
      return schedulerSettings.customWebsiteEnabled !== false
    }
    if (lower.includes('website') || lower.includes('visit') || lower.includes('personality')) {
      return schedulerSettings.websiteEnabled !== false
    }
    if (lower.includes('google') || lower.includes('search')) {
      return schedulerSettings.googleEnabled !== false
    }
    return true
  }

  function startSchedulerEngine() {
    if (schedulerTickTimer) clearInterval(schedulerTickTimer)
    
    // Tick every 60 seconds
    schedulerTickTimer = setInterval(async () => {
      try {
        if (!fs.existsSync(CONFIG_PATH)) return
        let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
        if (!config.scheduler || !config.scheduler.enabled) return
        
        const schedulerSettings = config.scheduler
        let maxConcurrent = schedulerSettings.maxConcurrentProfiles ?? 2
        
        // Dynamically throttle concurrency if VPS memory is constrained
        const vpsEng = getVPSEngine()
        if (vpsEng && vpsEng.isVPSEnabled()) {
          const memHealth = vpsEng.getMemoryHealth()
          if (memHealth.safeConcurrency < maxConcurrent) {
            maxConcurrent = memHealth.safeConcurrency
          }
        }
        let configChanged = false
        
        // Load proxy timezone details if available
        let proxies = []
        if (fs.existsSync(PROXIES_PATH)) {
          try {
            proxies = JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8')) || []
          } catch (e) {}
        }
        
        // Find all target profiles resolved under active scope
        let targets = []
        const scope = schedulerSettings.scope || 'all'
        
        if (scope === 'all') {
          if (fs.existsSync(PROFILES_BASE_DIR)) {
            const families = fs.readdirSync(PROFILES_BASE_DIR).filter(f => safeIsDirectory(path.join(PROFILES_BASE_DIR, f)))
            families.forEach(f => {
              const fPath = path.join(PROFILES_BASE_DIR, f)
              const profiles = fs.readdirSync(fPath).filter(p => safeIsDirectory(path.join(fPath, p)))
              profiles.forEach(p => targets.push({ profileId: p, family: f, id: `${f}/${p}` }))
            })
          }
        } else if (scope === 'family' && schedulerSettings.targetFamily) {
          const fPath = path.join(PROFILES_BASE_DIR, schedulerSettings.targetFamily)
          if (fs.existsSync(fPath)) {
            const profiles = fs.readdirSync(fPath).filter(p => safeIsDirectory(path.join(fPath, p)))
            profiles.forEach(p => targets.push({ profileId: p, family: schedulerSettings.targetFamily, id: `${schedulerSettings.targetFamily}/${p}` }))
          }
        } else if (scope === 'profile' && schedulerSettings.targetProfile) {
          const [f, p] = schedulerSettings.targetProfile.split('/')
          if (f && p) {
            targets.push({ profileId: p, family: f, id: schedulerSettings.targetProfile })
          }
        }
        
        for (const target of targets) {
          const profileConfig = schedulerSettings.profiles?.[target.id]
          if (!profileConfig || !profileConfig.enabled || !profileConfig.mode) continue
          
          // Determine timezone
          let timezone = 'UTC'
          const profileProxy = proxies.find(pr => pr.assignedProfiles?.includes(target.id))
          if (profileProxy?.timezone) {
            timezone = profileProxy.timezone
          } else {
            timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
          }
          
          // Get local hour/minute for target timezone
          let nowStr = ''
          try {
            const formatter = new Intl.DateTimeFormat('en-US', {
              timeZone: timezone,
              hour: '2-digit',
              minute: '2-digit',
              hour12: false
            })
            const parts = formatter.formatToParts(new Date())
            const hour = parts.find(p => p.type === 'hour')?.value || '00'
            const minute = parts.find(p => p.type === 'minute')?.value || '00'
            nowStr = `${hour}:${minute}`
          } catch (e) {
            const now = new Date()
            nowStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
          }
          
          const device = schedulerSettings.device || 'random'
          const browser = schedulerSettings.browser || 'random'
          
          // 1. Lifetime AI mode
          if (profileConfig.mode === 'lifetime' && Array.isArray(profileConfig.tasks)) {
            for (const task of profileConfig.tasks) {
              if (task.active !== false && task.time === nowStr && isTaskTypeEnabled(task.task, schedulerSettings)) {
                const scriptName = resolveScriptForTask(task.task, schedulerSettings)
                triggerTask(scriptName, target.profileId, target.family, device, browser, nowStr)
              }
            }
          }
          
          // 2. Warmer progressive mode
          if (profileConfig.mode === 'warmer' && profileConfig.warmerStartDate) {
            const elapsedMs = new Date().getTime() - new Date(profileConfig.warmerStartDate).getTime()
            const elapsedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000))
            const currentDay = Math.min(90, Math.max(1, 1 + elapsedDays))
            
            if (profileConfig.warmerProgressDay !== currentDay) {
              profileConfig.warmerProgressDay = currentDay
              configChanged = true
            }
            
            // Deterministically resolve warmer times
            const seedStr = `${target.id}_day_${currentDay}`
            let hash = 0
            for (let i = 0; i < seedStr.length; i++) {
              hash = seedStr.charCodeAt(i) + ((hash << 5) - hash)
            }
            hash = Math.abs(hash)
            
            const taskCount = 3 + (hash % 18)
            const minTime = 7 * 60
            const maxTime = 22 * 60 + 30
            const totalWindow = maxTime - minTime
            const interval = totalWindow / (taskCount - 1 || 1)
            
            const taskTimes = []
            for (let i = 0; i < taskCount; i++) {
              const jitterRange = Math.max(1, Math.floor(interval * 0.45))
              const jitter = ((hash >> (i % 6)) % jitterRange) - Math.floor(jitterRange / 2)
              const taskMinutes = Math.min(maxTime, Math.max(minTime, Math.floor(minTime + i * interval + jitter)))
              const hh = String(Math.floor(taskMinutes / 60)).padStart(2, '0')
              const mm = String(taskMinutes % 60).padStart(2, '0')
              taskTimes.push(`${hh}:${mm}`)
            }
            
            if (taskTimes.includes(nowStr)) {
              const warmerScriptsStr = schedulerSettings.warmerScripts || 'human_youtube_search.js, human_google_search.js, human_article_search.js'
              const scripts = warmerScriptsStr.split(',').map(s => s.trim()).filter(Boolean)
              const scriptIndex = (hash + taskTimes.indexOf(nowStr)) % (scripts.length || 1)
              const scriptName = scripts[scriptIndex] || 'human_google_search.js'
              triggerTask(scriptName, target.profileId, target.family, device, browser, nowStr)
            }
          }
        }
        
        if (configChanged) {
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8')
        }
        
        function triggerTask(scriptName, profileId, family, device, browser, timeStr) {
          const key = `${family}/${profileId}`
          if (lastRunTimes[key] === timeStr) return
          lastRunTimes[key] = timeStr
          
          const isRunning = botProcesses.some(bp => bp.profilePath && bp.profilePath.includes(path.join(family, profileId)))
          if (isRunning) return
          
          if (botProcesses.length >= maxConcurrent) {
            const isQueued = schedulerQueue.some(t => t.profileId === profileId)
            if (!isQueued) {
              console.log(`[Scheduler Queue] Concurrency reached. Queuing profile "${profileId}"`)
              schedulerQueue.push({ scriptName, profileId, family, device, browser, timeStr })
              
              const msg = `[Scheduler] Concurrency limit reached (${maxConcurrent}). Queued scheduled task "${scriptName}" for profile "${profileId}"`
              broadcastToWindows('bot-log', msg)
            }
          } else {
            executeBotInstance(scriptName, profileId, family, device, browser)
          }
        }
      } catch (err) {
        console.error('Scheduler Engine Ticker Error:', err)
      }
    }, 60000)
  }

  if (!fs.existsSync(PROFILES_BASE_DIR)) {
    fs.mkdirSync(PROFILES_BASE_DIR, { recursive: true })
  }

  // Only create a baseline DEFAULT family if the profiles directory is completely empty
  try {
    const existingFamilies = fs.readdirSync(PROFILES_BASE_DIR)
      .filter(f => {
        try {
          return fs.statSync(path.join(PROFILES_BASE_DIR, f)).isDirectory()
        } catch {
          return false
        }
      })
    if (existingFamilies.length === 0) {
      const defaultPath = path.join(PROFILES_BASE_DIR, 'DEFAULT')
      if (!fs.existsSync(defaultPath)) {
        fs.mkdirSync(defaultPath, { recursive: true })
      }
    }
  } catch (err) {
    console.error('Error checking default families:', err)
  }

  ipcMain.handle('get-families', async () => {
    try {
      if (!fs.existsSync(PROFILES_BASE_DIR)) return []
      const families = fs.readdirSync(PROFILES_BASE_DIR)
        .filter(f => {
          try {
            return fs.statSync(path.join(PROFILES_BASE_DIR, f)).isDirectory()
          } catch {
            return false
          }
        })

      const result = []
      for (const family of families) {
        const familyPath = path.join(PROFILES_BASE_DIR, family)
        const profiles = fs.readdirSync(familyPath)
          .filter(f => {
            try {
              return fs.statSync(path.join(familyPath, f)).isDirectory()
            } catch {
              return false
            }
          })
        
        const profileMeta = {}
        for (const p of profiles) {
          const fpPath = path.join(familyPath, p, 'fingerprint.json')
          let webglMode = 'generated'
          if (fs.existsSync(fpPath)) {
            try {
              const fp = JSON.parse(fs.readFileSync(fpPath, 'utf8'))
              if (fp.webglMode === 'real' || fp.fingerprint?.webglMode === 'real' || fp.fingerprint?.videoCard === null) {
                webglMode = 'real'
              }
            } catch (e) {}
          }
          profileMeta[p] = { webglMode }
        }

        result.push({ name: family, profiles, profileMeta })
      }
      return result
    } catch (error) {
      console.error('Error listing families:', error)
      return []
    }
  })

  ipcMain.handle('create-family', async (_, name) => {
    try {
      const familyPath = path.join(PROFILES_BASE_DIR, name)
      if (!fs.existsSync(familyPath)) {
        fs.mkdirSync(familyPath, { recursive: true })
        return { success: true }
      }
      return { success: false, error: 'Family already exists' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('create-profile', async (_, profileName, familyName, options = {}) => {
    try {
      const profilePath = path.join(PROFILES_BASE_DIR, familyName, profileName)
      if (!fs.existsSync(profilePath)) {
        fs.mkdirSync(profilePath, { recursive: true })
        const webglMode = options.webglMode || 'generated'
        const fpPath = path.join(profilePath, 'fingerprint.json')
        const fpContent = {
          webglMode: webglMode,
          createdAt: new Date().toISOString(),
          fingerprint: webglMode === 'real' ? { videoCard: null } : {}
        }
        fs.writeFileSync(fpPath, JSON.stringify(fpContent, null, 2), 'utf8')
        broadcastToWindows('profiles-updated');
        return { success: true }
      }
      return { success: false, error: 'Profile already exists' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('update-profile-webgl', async (_, familyName, profileName, webglMode) => {
    try {
      const profilePath = path.join(PROFILES_BASE_DIR, familyName, profileName)
      if (!fs.existsSync(profilePath)) {
        fs.mkdirSync(profilePath, { recursive: true })
      }
      const fpPath = path.join(profilePath, 'fingerprint.json')
      let fpData = {}
      if (fs.existsSync(fpPath)) {
        try { fpData = JSON.parse(fs.readFileSync(fpPath, 'utf8')) } catch (e) {}
      }
      fpData.webglMode = webglMode
      if (!fpData.fingerprint) fpData.fingerprint = {}
      if (webglMode === 'real') {
        fpData.fingerprint.videoCard = null
      } else {
        if (fpData.fingerprint.videoCard === null) {
          delete fpData.fingerprint.videoCard
        }
      }
      fs.writeFileSync(fpPath, JSON.stringify(fpData, null, 2), 'utf8')
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('export-profile', async (event, profileName, familyName) => {
    try {
      const sourcePath = path.join(PROFILES_BASE_DIR, familyName, profileName)
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: `Export Profile ${profileName}`,
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const destPath = path.join(result.filePaths[0], profileName)
        fs.cpSync(sourcePath, destPath, { recursive: true })
        return { success: true }
      }
      return { success: false }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('export-family', async (event, familyName) => {
    try {
      const sourcePath = path.join(PROFILES_BASE_DIR, familyName)
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: `Export Family ${familyName}`,
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const destPath = path.join(result.filePaths[0], familyName)
        fs.cpSync(sourcePath, destPath, { recursive: true })
        return { success: true }
      }
      return { success: false }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('import-profile', async (event, familyName) => {
    try {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        title: `Import Profile into ${familyName}`,
        properties: ['openDirectory']
      })

      if (!result.canceled && result.filePaths.length > 0) {
        const sourcePath = result.filePaths[0]
        const profileName = path.basename(sourcePath)
        const destPath = path.join(PROFILES_BASE_DIR, familyName, profileName)

        if (fs.existsSync(destPath)) {
          return { success: false, error: 'A profile with this name already exists in this family' }
        }

        fs.cpSync(sourcePath, destPath, { recursive: true })
        return { success: true }
      }
      return { success: false }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rename-family', async (_, oldName, newName) => {
    try {
      const oldPath = path.join(PROFILES_BASE_DIR, oldName)
      const newPath = path.join(PROFILES_BASE_DIR, newName)
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath)
        return { success: true }
      }
      return { success: false, error: 'Family not found' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('delete-family', async (_, name) => {
    try {
      const familyPath = path.join(PROFILES_BASE_DIR, name)
      if (fs.existsSync(familyPath)) {
        fs.rmSync(familyPath, { recursive: true, force: true })
        return { success: true }
      }
      return { success: false, error: 'Family not found' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('get-profiles', async () => {
    try {
      if (!fs.existsSync(PROFILES_BASE_DIR)) return []
      const families = fs.readdirSync(PROFILES_BASE_DIR)
        .filter(f => {
          try {
            return fs.statSync(path.join(PROFILES_BASE_DIR, f)).isDirectory()
          } catch (e) {
            return false
          }
        })
      let allProfiles = []
      for (const family of families) {
        const familyPath = path.join(PROFILES_BASE_DIR, family)
        try {
          const profiles = fs.readdirSync(familyPath)
            .filter(f => {
              try {
                return fs.statSync(path.join(familyPath, f)).isDirectory()
              } catch (e) {
                return false
              }
            })
            .map(p => ({ id: p, family }))
          allProfiles = [...allProfiles, ...profiles]
        } catch (e) {}
      }
      return allProfiles
    } catch (error) {
      console.error('[get-profiles error]:', error)
      return []
    }
  })

  ipcMain.handle('delete-profile', async (_, profileName, family = 'DEFAULT') => {
    try {
      const familyPath = path.join(PROFILES_BASE_DIR, family)
      const profilePath = path.join(familyPath, profileName)
      if (fs.existsSync(profilePath)) {
        fs.rmSync(profilePath, { recursive: true, force: true })
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rename-profile', async (_, oldName, newName, family = 'DEFAULT') => {
    try {
      const familyPath = path.join(PROFILES_BASE_DIR, family)
      const oldPath = path.join(familyPath, oldName)
      const newPath = path.join(familyPath, newName)
      if (fs.existsSync(oldPath)) {
        fs.renameSync(oldPath, newPath)
        return { success: true }
      }
      return { success: false, error: 'Profile not found' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('move-profile', async (_, profileId, oldFamily, newFamily) => {
    try {
      const oldPath = path.join(PROFILES_BASE_DIR, oldFamily, profileId)
      const newPath = path.join(PROFILES_BASE_DIR, newFamily, profileId)
      if (fs.existsSync(oldPath)) {
        if (!fs.existsSync(path.dirname(newPath))) {
          fs.mkdirSync(path.dirname(newPath), { recursive: true })
        }
        fs.renameSync(oldPath, newPath)
        return { success: true }
      }
      return { success: false, error: 'Profile not found' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('delete-all-profiles', async () => {
    try {
      if (fs.existsSync(PROFILES_BASE_DIR)) {
        fs.rmSync(PROFILES_BASE_DIR, { recursive: true, force: true })
        fs.mkdirSync(PROFILES_BASE_DIR, { recursive: true })
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  const getCurrentBotStatus = (winId = null) => {
    const filtered = winId ? botProcesses.filter(p => p.winId === winId) : botProcesses
    if (filtered.length === 0) return { status: 'stopped', instances: [] }
    return {
      status: `running (${filtered.length} instances)`,
      instances: filtered.map(p => ({
        profilePath: p.profilePath,
        profileType: p.profileType,
        startTime: p.startTime
      }))
    }
  }

  ipcMain.handle('start-bot', async (event, scriptName = 'human_google_search.js', options = {}) => {
    const {
      instanceCount = 1,
      profileType = 'temporary',
      specificProfile = null,
      family = 'DEFAULT',
      launchMode = 'single', // 'single', 'random', 'all'
      randomCount = 1,
      device = 'random',
      browser = 'random',
      headless = false,
      concurrencyLimit = 3,
      webglMode = 'generated'
    } = options

    let scriptPath = resolveAppPath(scriptName)
    if (!fs.existsSync(scriptPath)) {
      if (fs.existsSync(resolveAppPath('test.js'))) {
        scriptPath = resolveAppPath('test.js');
      }
    }
    const baseUserDataDir = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).paths.userDataDir

    let targets = []
    let warnings = []

    if (specificProfile) {
      targets.push({ id: specificProfile, family: family })
    } else if (profileType === 'permanent') {
      const familyPath = path.join(PROFILES_BASE_DIR, family)
      const existingProfiles = fs.existsSync(familyPath)
        ? fs.readdirSync(familyPath).filter(f => safeIsDirectory(path.join(familyPath, f)))
        : []

      if ((launchMode === 'all' || launchMode === 'random') && existingProfiles.length === 0) {
        event.sender.send('bot-log', `⚠️ Family "${family}" is empty. Automatically creating a new profile for you...`)
        const id = `profile_${Date.now()}`
        targets.push({ id, family })
      } else if (launchMode === 'all') {
        targets = existingProfiles.map(p => ({ id: p, family }))
      } else if (launchMode === 'random') {
        const shuffled = existingProfiles.sort(() => 0.5 - Math.random())
        targets = shuffled.slice(0, Math.min(randomCount, shuffled.length)).map(p => ({ id: p, family }))
      } else {
        // Create new profiles (Single mode)
        for (let i = 0; i < instanceCount; i++) {
          const id = `profile_${Date.now() + i}`
          targets.push({ id, family })
        }
      }
    } else {
      // Temporary
      for (let i = 0; i < instanceCount; i++) {
        targets.push({ id: null, family: null })
      }
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    const winId = win ? win.id : 'default';

    for (const target of targets) {
      let profilePath

      if (target.id) {
        profilePath = path.join(PROFILES_BASE_DIR, target.family, target.id)
      } else {
        // Temporary
        profilePath = path.join(os.tmpdir(), `bot-temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`)
      }

      // Determine profile WebGL setting: profile fingerprint.json overrides or uses specified webglMode
      let effectiveWebgl = webglMode;
      if (target.id && fs.existsSync(path.join(profilePath, 'fingerprint.json'))) {
        try {
          const fp = JSON.parse(fs.readFileSync(path.join(profilePath, 'fingerprint.json'), 'utf8'));
          if (fp.webglMode) effectiveWebgl = fp.webglMode;
          else if (fp.fingerprint?.videoCard === null) effectiveWebgl = 'real';
        } catch (e) {}
      }

      manualQueue.push({
        scriptPath,
        profilePath,
        profileType: target.id ? 'permanent' : 'temporary',
        device,
        browser,
        headless,
        webglMode: effectiveWebgl,
        sender: event.sender,
        botIndex: targets.indexOf(target) + 1,
        concurrencyLimit,
        winId
      })
    }

    event.sender.send('bot-log', `[Launcher] Enqueued ${targets.length} bot tasks. (Max Concurrency Limit: ${concurrencyLimit})`)
    processManualQueue()

    event.sender.send('bot-status', getCurrentBotStatus(winId))
    return { success: true, warnings }
  })

  ipcMain.handle('stop-bot', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const winId = win ? win.id : null;
    if (!winId) return { success: false, message: 'Invalid window context' };

    // Clear queued tasks for this window only
    manualQueue = manualQueue.filter(t => t.winId !== winId);

    const winBots = botProcesses.filter(p => p.winId === winId);
    if (winBots.length > 0) {
      winBots.forEach(p => p.process.kill());
      botProcesses = botProcesses.filter(p => p.winId !== winId);
      return { success: true };
    }
    return { success: false, message: 'No bots running for this window' };
  })

  ipcMain.handle('stop-specific-bot', async (event, profilePath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const winId = win ? win.id : null;
    const bot = botProcesses.find(p => p.profilePath === profilePath && p.winId === winId)
    if (bot) {
      bot.process.kill()
      // The 'close' listener in start-bot will handle cleanup
      return { success: true }
    }
    return { success: false, message: 'Bot not found' }
  })

  ipcMain.handle('get-bot-status', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const winId = win ? win.id : null;
    return getCurrentBotStatus(winId);
  })

  // --- Resource Monitoring ---

  async function getDirSize(dirPath) {
    let size = 0
    try {
      const files = fs.readdirSync(dirPath)
      for (const file of files) {
        const filePath = path.join(dirPath, file)
        const stats = fs.statSync(filePath)
        if (stats.isDirectory()) {
          size += await getDirSize(filePath)
        } else {
          size += stats.size
        }
      }
    } catch (e) { }
    return size
  }

  ipcMain.handle('get-system-stats', async () => {
    try {
      // 1. System RAM
      const totalMem = os.totalmem()
      const freeMem = os.freemem()
      const usedMem = totalMem - freeMem

      // 2. System Disk
      let freeDisk = 0
      let totalDisk = 0
      try {
        if (process.platform === 'win32') {
          const { stdout } = await execPromise('powershell "Get-PSDrive C | Select-Object Free, @{Name=\'Total\';Expression={$_.Free + $_.Used}} | ConvertTo-Json"')
          if (stdout && stdout.trim()) {
            const diskData = JSON.parse(stdout)
            freeDisk = diskData.Free || 0
            totalDisk = diskData.Total || 0
          }
        } else {
          // Linux / macOS / Unix: Use df -kP
          const checkDir = resolveAppPath('')
          const { stdout } = await execPromise(`df -kP "${checkDir}" 2>/dev/null || df -kP /`)
          const lines = stdout.trim().split('\n')
          if (lines.length >= 2) {
            const parts = lines[lines.length - 1].trim().split(/\s+/)
            if (parts.length >= 4) {
              const totalKb = parseInt(parts[1], 10) || 0
              const availKb = parseInt(parts[3], 10) || 0
              totalDisk = totalKb * 1024
              freeDisk = availKb * 1024
            }
          }
        }
      } catch (e) {
        console.error('Error getting disk info:', e)
      }

      // 3. Bot RAM (Aggregate all node and chrome processes)
      let botsRam = 0
      if (botProcesses.length > 0) {
        try {
          if (process.platform === 'win32') {
            const { stdout } = await execPromise('tasklist /fo csv /nh /fi "IMAGENAME eq chrome.exe"')
            const lines = stdout.split('\n')
            lines.forEach(line => {
              const parts = line.split('","')
              if (parts.length > 4) {
                const memStr = parts[4].replace(/[^\d]/g, '')
                botsRam += parseInt(memStr) * 1024 // tasklist gives KB
              }
            })
          } else {
            // Linux / macOS: Use ps to get memory of chrome/chromium/node
            const { stdout } = await execPromise('ps -eo rss,comm 2>/dev/null | grep -E "(chrome|chromium)" || true')
            const lines = stdout.trim().split('\n')
            lines.forEach(line => {
              const parts = line.trim().split(/\s+/)
              if (parts.length >= 1 && parts[0]) {
                const memKb = parseInt(parts[0], 10)
                if (!isNaN(memKb)) {
                  botsRam += memKb * 1024
                }
              }
            })
          }
        } catch (e) { }
      }

      // 4. Bot Disk Usage
      let botsDisk = 0
      if (fs.existsSync(PROFILES_BASE_DIR)) {
        botsDisk += await getDirSize(PROFILES_BASE_DIR)
      }
      // Add temp profiles if any
      for (const p of botProcesses) {
        if (p.profileType === 'temporary' && fs.existsSync(p.profilePath)) {
          botsDisk += await getDirSize(p.profilePath)
        }
      }

      return {
        system: {
          totalMem,
          freeMem,
          usedMem,
          totalDisk,
          freeDisk,
          cpuCores: os.cpus().length
        },
        bots: {
          ram: botsRam,
          disk: botsDisk,
          count: botProcesses.length
        }
      }
    } catch (error) {
      console.error('Error in get-system-stats:', error)
      return null
    }
  })

  ipcMain.handle('clear-browser-data', async () => {
    try {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8')
      const config = JSON.parse(data)
      const userDataDir = config.paths.userDataDir

      if (!fs.existsSync(userDataDir)) {
        return { success: false, error: 'Data directory not found' }
      }

      console.log(`🧹 Attempting to clear browser data at: ${userDataDir}`)

      // Try to kill chrome processes first to release file locks
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/F', '/IM', 'chrome.exe', '/T'])
        } else {
          spawn('pkill', ['-f', 'chrome'])
        }
        // Give it a moment to release locks
        await new Promise(r => setTimeout(r, 2000))
      } catch (e) {
        console.warn('Failed to kill chrome processes:', e.message)
      }

      try {
        // Recursive delete
        fs.rmSync(userDataDir, { recursive: true, force: true })
        // Recreate the empty directory
        fs.mkdirSync(userDataDir, { recursive: true })
        return { success: true }
      } catch (rmError) {
        if (rmError.code === 'EPERM' || rmError.code === 'EBUSY') {
          return {
            success: false,
            error: 'Permission Denied: Some files are still in use. Please ensure all browser windows are closed and try again.'
          }
        }
        throw rmError
      }
    } catch (error) {
      console.error('Error clearing data:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('smart-clear-data', async (event) => {
    return new Promise((resolve) => {
      const scriptPath = resolveAppPath('smart_clear.js')
      console.log(`Launching Smart Clear: ${scriptPath}`)

      const process = spawnNode(scriptPath, [])

      process.stdout.on('data', (data) => {
        event.sender.send('bot-log', data.toString())
      })

      process.stderr.on('data', (data) => {
        event.sender.send('bot-log', `ERROR: ${data.toString()}`)
      })

      process.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true })
        } else {
          resolve({ success: false, error: `Process exited with code ${code}` })
        }
      })
    })
  })

  // ─── VPS Engine IPC Handlers ────────────────────────────────────────────────
  ipcMain.handle('get-vps-status', async () => {
    try {
      const engine = getVPSEngine()
      if (!engine) {
        const totalMem = os.totalmem()
        const freeMem = os.freemem()
        const usedMem = totalMem - freeMem
        const freeMemMb = Math.round(freeMem / (1024 * 1024))
        const totalMemMb = Math.round(totalMem / (1024 * 1024))
        const freeMemPercent = totalMemMb > 0 ? Math.round((freeMemMb / totalMemMb) * 100) : 0
        const pressure = freeMemMb < 400 ? 'critical' : freeMemMb < 800 ? 'moderate' : 'low'
        return {
          success: true,
          isEnabled: false,
          isVPS: false,
          reasons: ['Direct system OS metrics'],
          profile: 'standard',
          metrics: {
            totalMemMb,
            freeMemMb,
            usedMemMb: Math.round(usedMem / (1024 * 1024)),
            freeMemPercent,
            cpuCores: os.cpus().length,
            platform: process.platform,
            uptimeHours: (os.uptime() / 3600).toFixed(1)
          },
          health: {
            pressure,
            freeMb: freeMemMb,
            freePercent: freeMemPercent,
            safeConcurrency: Math.max(1, Math.min(2, Math.floor(freeMemMb / 600))),
            warning: null
          },
          config: {}
        }
      }
      const detection = engine.detectVPSEnvironment()
      const health = engine.getMemoryHealth()
      const isEnabled = engine.isVPSEnabled()
      const config = engine.getConfig()

      return {
        success: true,
        isEnabled,
        isVPS: detection.isVPS,
        reasons: detection.reasons,
        profile: detection.profile,
        metrics: detection.metrics,
        health,
        config
      }
    } catch (e) {
      console.error('Error getting VPS status:', e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('apply-vps-optimization', async () => {
    try {
      const engine = getVPSEngine()
      if (!fs.existsSync(CONFIG_PATH)) return { success: false, error: 'Config file not found' }
      
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      config.vps = {
        enabled: true,
        lowMemoryMode: true,
        rendererProcessLimit: 1,
        maxV8MemoryMb: 256,
        blockHeavyMedia: true,
        autoReapZombies: true,
        reapIntervalMinutes: 10,
        pruneCacheOnStartup: true
      }

      if (config.hardware?.acceleration) {
        config.hardware.acceleration.enabled = false
      }

      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4))
      
      let cleaned = { reapedCount: 0, freedMb: '0.0' }
      if (engine) {
        const r1 = engine.reapZombieProcesses()
        const r2 = engine.pruneDiskBloat()
        cleaned = { reapedCount: r1.reapedCount, freedMb: r2.freedMb }
      }

      return { success: true, message: 'VPS Optimizations applied successfully!', cleaned }
    } catch (e) {
      console.error('Error applying VPS optimization:', e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('reap-zombie-processes', async () => {
    try {
      const engine = getVPSEngine()
      if (!engine) return { success: false, error: 'VPS Engine not available' }
      const res = engine.reapZombieProcesses()
      return { success: true, reapedCount: res.reapedCount }
    } catch (e) {
      console.error('Error reaping zombie processes:', e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('prune-vps-cache', async () => {
    try {
      const engine = getVPSEngine()
      if (!engine) return { success: false, error: 'VPS Engine not available' }
      const res = engine.pruneDiskBloat()
      return { success: true, freedMb: res.freedMb, cleanedDirsCount: res.cleanedDirsCount }
    } catch (e) {
      console.error('Error pruning cache:', e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('save-vps-config', async (_, vpsSettings) => {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return { success: false, error: 'Config file not found' }
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      config.vps = {
        ...(config.vps || {}),
        ...vpsSettings
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4))
      return { success: true }
    } catch (e) {
      console.error('Error saving VPS config:', e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('get-proxies', async () => {
    try {
      if (fs.existsSync(PROXIES_PATH)) {
        return JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8'))
      }
      return []
    } catch (error) {
      console.error('Error reading proxies:', error)
      return []
    }
  })

  ipcMain.handle('save-proxies', async (_, proxies) => {
    try {
      fs.writeFileSync(PROXIES_PATH, JSON.stringify(proxies, null, 4), 'utf8')
      return { success: true }
    } catch (error) {
      console.error('Error saving proxies:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('fetch-webshare-profile', async (_, { apiKey }) => {
    try {
      const axios = require('axios')
      const response = await axios.get('https://proxy.webshare.io/api/v2/profile/', {
        headers: { Authorization: `Token ${apiKey}` },
        timeout: 10000
      })
      return { success: true, data: response.data }
    } catch (error) {
      console.error('Error fetching Webshare profile:', error)
      return { success: false, error: error.response?.data ? JSON.stringify(error.response.data) : error.message }
    }
  })

  ipcMain.handle('fetch-webshare-stats', async (_, { apiKey }) => {
    try {
      const axios = require('axios')
      const response = await axios.get('https://proxy.webshare.io/api/v2/stats/aggregate/', {
        headers: { Authorization: `Token ${apiKey}` },
        timeout: 10000
      })
      return { success: true, data: response.data }
    } catch (error) {
      console.error('Error fetching Webshare stats:', error)
      return { success: false, error: error.response?.data ? JSON.stringify(error.response.data) : error.message }
    }
  })

  ipcMain.handle('fetch-webshare-proxies', async (_, { apiKey, mode, limit }) => {
    try {
      const axios = require('axios')
      const allProxies = fs.existsSync(PROXIES_PATH) ? JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8')) : []
      
      let page = 1
      let importedCount = 0
      let fetchedResults = []
      
      while (fetchedResults.length < limit) {
        const response = await axios.get('https://proxy.webshare.io/api/v2/proxy/list/', {
          headers: { Authorization: `Token ${apiKey}` },
          params: {
            page: page,
            page_size: Math.min(100, limit - fetchedResults.length),
            mode: mode || 'direct'
          },
          timeout: 15000
        })
        
        const results = response.data.results || []
        if (results.length === 0) break
        
        fetchedResults = fetchedResults.concat(results)
        if (!response.data.next) break
        page++
      }

      for (const item of fetchedResults) {
        if (!allProxies.some(p => p.host === item.proxy_address && p.port === item.port)) {
          allProxies.push({
            host: item.proxy_address,
            port: item.port,
            protocol: 'http',
            username: item.username,
            password: item.password,
            assignedProfiles: []
          })
          importedCount++
        }
      }

      fs.writeFileSync(PROXIES_PATH, JSON.stringify(allProxies, null, 4), 'utf8')
      return { success: true, count: importedCount, total: allProxies.length }
    } catch (error) {
      console.error('Error fetching Webshare proxies:', error)
      return { success: false, error: error.response?.data ? JSON.stringify(error.response.data) : error.message }
    }
  })

  ipcMain.handle('fetch-dataimpulse-balance', async (_, { resellerToken }) => {
    try {
      const axios = require('axios')
      const response = await axios.get('https://api.dataimpulse.com/reseller/user/balance', {
        headers: { Authorization: `Bearer ${resellerToken}` },
        timeout: 10000
      })
      return { success: true, data: response.data }
    } catch (error) {
      console.error('Error fetching Dataimpulse balance:', error)
      return { success: false, error: error.response?.data ? JSON.stringify(error.response.data) : error.message }
    }
  })

  ipcMain.handle('generate-dataimpulse-proxies', async (_, { username, password, host, portStart, portEnd, protocol }) => {
    try {
      const allProxies = fs.existsSync(PROXIES_PATH) ? JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8')) : []
      let generatedCount = 0

      const start = parseInt(portStart) || 10000
      const end = parseInt(portEnd) || 10000
      const actualHost = host || 'gw.dataimpulse.com'
      const actualProto = protocol || 'http'

      for (let port = start; port <= end; port++) {
        if (!allProxies.some(p => p.host === actualHost && p.port === port)) {
          allProxies.push({
            host: actualHost,
            port: port,
            protocol: actualProto,
            username: username,
            password: password,
            assignedProfiles: []
          })
          generatedCount++
        }
      }

      fs.writeFileSync(PROXIES_PATH, JSON.stringify(allProxies, null, 4), 'utf8')
      return { success: true, count: generatedCount, total: allProxies.length }
    } catch (error) {
      console.error('Error generating Dataimpulse proxies:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('assign-proxy', async (_, { proxy, profiles }) => {
    try {
      // proxy: { host, port, protocol, username, password }
      // profiles: [{ id, family }]

      const allProxies = fs.existsSync(PROXIES_PATH) ? JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8')) : []
      const targetProxy = allProxies.find(p => p.host === proxy.host && p.port === proxy.port)

      if (!targetProxy) return { success: false, error: 'Proxy not found in list' }

      // Check limits
      const currentAssigned = targetProxy.assignedProfiles || []
      if (currentAssigned.length + profiles.length > 10) {
        return { success: false, error: `Proxy limit reached. A proxy can be attached to maximum 10 profiles. Current: ${currentAssigned.length}` }
      }

      const warnings = []

      for (const p of profiles) {
        const profilePath = path.join(PROFILES_BASE_DIR, p.family, p.id)
        const proxyConfigPath = path.join(profilePath, 'proxy.json')

        if (fs.existsSync(proxyConfigPath)) {
          const oldProxy = JSON.parse(fs.readFileSync(proxyConfigPath, 'utf8'))
          warnings.push({ profile: p.id, oldProxy: `${oldProxy.host}:${oldProxy.port}` })
        }

        // Write proxy.json to profile dir
        if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true })
        fs.writeFileSync(proxyConfigPath, JSON.stringify(proxy, null, 4))

        // Update proxies.json list
        if (!targetProxy.assignedProfiles) targetProxy.assignedProfiles = []
        if (!targetProxy.assignedProfiles.some(ap => ap.id === p.id && ap.family === p.family)) {
          targetProxy.assignedProfiles.push({ id: p.id, family: p.family })
        }
      }

      fs.writeFileSync(PROXIES_PATH, JSON.stringify(allProxies, null, 4))
      return { success: true, warnings }
    } catch (error) {
      console.error('Error assigning proxy:', error)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('get-profile-proxy', async (_, { id, family }) => {
    try {
      const proxyPath = path.join(PROFILES_BASE_DIR, family, id, 'proxy.json')
      if (fs.existsSync(proxyPath)) {
        return JSON.parse(fs.readFileSync(proxyPath, 'utf8'))
      }
      return null
    } catch (e) {
      return null
    }
  })

  ipcMain.handle('auto-assign-proxies', async () => {
    try {
      const allProxies = fs.existsSync(PROXIES_PATH) ? JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8')) : []
      if (allProxies.length === 0) {
        return { success: false, error: 'Your proxy pool is empty. Please add proxies first.' }
      }

      // Find all permanent profiles across all families
      const families = fs.existsSync(PROFILES_BASE_DIR)
        ? fs.readdirSync(PROFILES_BASE_DIR).filter(f => safeIsDirectory(path.join(PROFILES_BASE_DIR, f)))
        : []

      const profilesWithoutProxy = []
      for (const fam of families) {
        const familyPath = path.join(PROFILES_BASE_DIR, fam)
        const profiles = fs.readdirSync(familyPath).filter(f => safeIsDirectory(path.join(familyPath, f)))
        for (const p of profiles) {
          const proxyPath = path.join(familyPath, p, 'proxy.json')
          if (!fs.existsSync(proxyPath)) {
            profilesWithoutProxy.push({ id: p, family: fam })
          }
        }
      }

      if (profilesWithoutProxy.length === 0) {
        return { success: true, count: 0, message: 'All profiles already have a proxy assigned.' }
      }

      // Distribute proxies from pool to these profiles
      let assignedCount = 0
      for (const profile of profilesWithoutProxy) {
        // Find a proxy from allProxies that has less than 10 assignments
        const availableProxy = allProxies.find(p => (p.assignedProfiles || []).length < 10)
        if (!availableProxy) {
          fs.writeFileSync(PROXIES_PATH, JSON.stringify(allProxies, null, 4))
          return {
            success: true,
            count: assignedCount,
            message: `Assigned proxies to ${assignedCount} profiles. Stopped because all proxies in your pool have reached their 10-profile concurrency limit. Please add more proxies.`
          }
        }

        // Assign proxy to this profile
        const profilePath = path.join(PROFILES_BASE_DIR, profile.family, profile.id)
        const proxyConfigPath = path.join(profilePath, 'proxy.json')
        
        if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true })
        fs.writeFileSync(proxyConfigPath, JSON.stringify({
          host: availableProxy.host,
          port: availableProxy.port,
          protocol: availableProxy.protocol || 'http',
          username: availableProxy.username,
          password: availableProxy.password
        }, null, 4))

        if (!availableProxy.assignedProfiles) availableProxy.assignedProfiles = []
        availableProxy.assignedProfiles.push({ id: profile.id, family: profile.family })
        assignedCount++
      }

      fs.writeFileSync(PROXIES_PATH, JSON.stringify(allProxies, null, 4))
      return { success: true, count: assignedCount, message: `Successfully assigned proxies to ${assignedCount} profiles!` }
    } catch (e) {
      console.error(e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('remove-all-proxies', async () => {
    try {
      const families = fs.existsSync(PROFILES_BASE_DIR)
        ? fs.readdirSync(PROFILES_BASE_DIR).filter(f => safeIsDirectory(path.join(PROFILES_BASE_DIR, f)))
        : []

      let removedCount = 0
      for (const fam of families) {
        const familyPath = path.join(PROFILES_BASE_DIR, fam)
        const profiles = fs.readdirSync(familyPath).filter(f => safeIsDirectory(path.join(familyPath, f)))
        for (const p of profiles) {
          const proxyPath = path.join(familyPath, p, 'proxy.json')
          if (fs.existsSync(proxyPath)) {
            fs.unlinkSync(proxyPath)
            removedCount++
          }
        }
      }

      if (fs.existsSync(PROXIES_PATH)) {
        const allProxies = JSON.parse(fs.readFileSync(PROXIES_PATH, 'utf8'))
        const clearedProxies = allProxies.map(p => {
          return { ...p, assignedProfiles: [] }
        })
        fs.writeFileSync(PROXIES_PATH, JSON.stringify(clearedProxies, null, 4))
      }

      return { success: true, count: removedCount, message: `Successfully removed proxies from all ${removedCount} profiles!` }
    } catch (e) {
      console.error(e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('get-profile-history', async (_, { id, family }) => {
    try {
      const historyPath = path.join(PROFILES_BASE_DIR, family, id, 'history.json')
      if (fs.existsSync(historyPath)) {
        return JSON.parse(fs.readFileSync(historyPath, 'utf8'))
      }
      return {
        currentIp: 'Unknown',
        currentTimezone: 'Unknown',
        previousIp: 'Unknown',
        previousTimezone: 'Unknown',
        history: []
      }
    } catch (e) {
      return {
        currentIp: 'Unknown',
        currentTimezone: 'Unknown',
        previousIp: 'Unknown',
        previousTimezone: 'Unknown',
        history: []
      }
    }
  })

  ipcMain.handle('clear-profile-history', async (_, { id, family }) => {
    try {
      const historyPath = path.join(PROFILES_BASE_DIR, family, id, 'history.json')
      if (fs.existsSync(historyPath)) {
        fs.unlinkSync(historyPath)
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('clear-family-history', async (_, familyName) => {
    try {
      const familyPath = path.join(PROFILES_BASE_DIR, familyName)
      if (fs.existsSync(familyPath)) {
        const profiles = fs.readdirSync(familyPath).filter(f => safeIsDirectory(path.join(familyPath, f)))
        for (const p of profiles) {
          const historyPath = path.join(familyPath, p, 'history.json')
          if (fs.existsSync(historyPath)) {
            fs.unlinkSync(historyPath)
          }
        }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('clear-all-histories', async () => {
    try {
      if (fs.existsSync(PROFILES_BASE_DIR)) {
        const families = fs.readdirSync(PROFILES_BASE_DIR).filter(f => safeIsDirectory(path.join(PROFILES_BASE_DIR, f)))
        for (const fam of families) {
          const familyPath = path.join(PROFILES_BASE_DIR, fam)
          const profiles = fs.readdirSync(familyPath).filter(p => safeIsDirectory(path.join(familyPath, p)))
          for (const p of profiles) {
            const historyPath = path.join(familyPath, p, 'history.json')
            if (fs.existsSync(historyPath)) {
              fs.unlinkSync(historyPath)
            }
          }
        }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('select-proxies-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    })
    if (!result.canceled) {
      const content = fs.readFileSync(result.filePaths[0], 'utf8')
      return { success: true, content }
    }
    return { success: false }
  })
  ipcMain.handle('read-personalities', async () => {
    try {
      if (!fs.existsSync(PERSONALITIES_PATH)) return {};
      let data = JSON.parse(fs.readFileSync(PERSONALITIES_PATH, 'utf8'));
      
      // Check for auto-evolution
      let changed = false;
      const configJson = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const aiConfig = configJson.ai || {};
      const provider = aiConfig.provider || 'deepseek';
      let apiKey = '';
      if (provider === 'deepseek') apiKey = aiConfig.deepseekApiKey;
      else if (provider === 'openai') apiKey = aiConfig.openaiApiKey;
      else if (provider === 'anthropic') apiKey = aiConfig.anthropicApiKey;
      else if (provider === 'gemini') apiKey = aiConfig.geminiApiKey;

      if (apiKey) {
        // --- Evolution for Individual Profiles ---
        for (const key in data) {
          const p = data[key];
          if (p.autoEvolve && p.description) {
            const now = Date.now();
            const last = p.lastEvolved || 0;
            const intervalMs = {
              'daily': 24 * 60 * 60 * 1000,
              'weekly': 7 * 24 * 60 * 60 * 1000,
              'monthly': 30 * 24 * 60 * 60 * 1000
            }[p.evolveInterval || 'daily'];

            if (now - last > intervalMs) {
              console.log(`✨ Auto-evolving personality for ${key}...`);
              try {
                const systemPrompt = "You are a behavioral psychologist. Convert a personality description into 19 bot parameters. Return ONLY JSON with fields: \"adSkipPercentage\" (0-100), \"watchScrollPercentage\" (0-100), \"suggestedVideoClickPercentage\" (0-100), \"behaviorChangeFrequency\" (0-120), \"searchPage1ScrollChance\" (0-100), \"searchPage2ScrollChance\" (0-100), \"searchPage3ScrollChance\" (0-100), \"searchPage4ScrollChance\" (0-100), \"searchPage5ScrollChance\" (0-100), \"likePercentage\" (0-100), \"commentPercentage\" (0-100), \"minWatchMinutes\" (1-10), \"maxWatchMinutes\" (2-30), \"minAdInteractionSeconds\" (5-30), \"maxAdInteractionSeconds\" (10-120), \"adPageInnerClickPercentage\" (0-100), \"playbackSpeed2xPercentage\" (0-100), \"enableSubtitlesPercentage\" (0-100), \"volumeChangePercentage\" (0-100). No markdown, no extra text.";
                const userPrompt = `Personality: ${p.description}`;
                const content = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.7 });
                const jsonStr = content.replace(/```json|```/g, '');
                const newData = JSON.parse(jsonStr);
                data[key] = { ...p, settings: newData, lastEvolved: now };
                changed = true;
              } catch (err) { console.error('Evolve Error:', err); }
            }
          }
        }

        // --- Evolution for Global Automation ---
        const auto = configJson.automation;
        if (auto && auto.autoEvolve && auto.youtubeTarget) {
          const now = Date.now();
          const last = auto.lastEvolved || 0;
          const intervalMs = {
            'daily': 24 * 60 * 60 * 1000,
            'weekly': 7 * 24 * 60 * 60 * 1000,
            'monthly': 30 * 24 * 60 * 60 * 1000
          }[auto.evolveInterval || 'daily'];

          if (now - last > intervalMs) {
            console.log(`✨ Auto-evolving Global Behavioral Settings...`);
            try {
              const systemPrompt = "You are a behavioral psychologist. Convert a YouTube search target into 19 bot parameters. Return ONLY JSON with fields: \"adSkipPercentage\" (0-100), \"watchScrollPercentage\" (0-100), \"suggestedVideoClickPercentage\" (0-100), \"behaviorChangeFrequency\" (0-120), \"searchPage1ScrollChance\" (0-100), \"searchPage2ScrollChance\" (0-100), \"searchPage3ScrollChance\" (0-100), \"searchPage4ScrollChance\" (0-100), \"searchPage5ScrollChance\" (0-100), \"likePercentage\" (0-100), \"commentPercentage\" (0-100), \"minWatchMinutes\" (1-10), \"maxWatchMinutes\" (2-30), \"minAdInteractionSeconds\" (5-30), \"maxAdInteractionSeconds\" (10-120), \"adPageInnerClickPercentage\" (0-100), \"playbackSpeed2xPercentage\" (0-100), \"enableSubtitlesPercentage\" (0-100), \"volumeChangePercentage\" (0-100). No markdown, no extra text.";
              const userPrompt = `Target Keyword: ${auto.youtubeTarget}`;
              const content = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.7 });
              const jsonStr = content.replace(/```json|```/g, '');
              const newData = JSON.parse(jsonStr);
              configJson.automation = { 
                ...auto, 
                adSkipPercentage: newData.adSkipPercentage,
                watchScrollPercentage: newData.watchScrollPercentage,
                suggestedVideoClickPercentage: newData.suggestedVideoClickPercentage,
                behaviorChangeFrequency: newData.behaviorChangeFrequency,
                searchPage1ScrollChance: newData.searchPage1ScrollChance !== undefined ? newData.searchPage1ScrollChance : 100,
                searchPage2ScrollChance: newData.searchPage2ScrollChance !== undefined ? newData.searchPage2ScrollChance : 80,
                searchPage3ScrollChance: newData.searchPage3ScrollChance !== undefined ? newData.searchPage3ScrollChance : 50,
                searchPage4ScrollChance: newData.searchPage4ScrollChance !== undefined ? newData.searchPage4ScrollChance : 20,
                searchPage5ScrollChance: newData.searchPage5ScrollChance !== undefined ? newData.searchPage5ScrollChance : 0,
                likePercentage: newData.likePercentage !== undefined ? newData.likePercentage : 15,
                commentPercentage: newData.commentPercentage !== undefined ? newData.commentPercentage : 5,
                minWatchMinutes: newData.minWatchMinutes !== undefined ? newData.minWatchMinutes : 2,
                maxWatchMinutes: newData.maxWatchMinutes !== undefined ? newData.maxWatchMinutes : 5,
                minAdInteractionSeconds: newData.minAdInteractionSeconds !== undefined ? newData.minAdInteractionSeconds : 10,
                maxAdInteractionSeconds: newData.maxAdInteractionSeconds !== undefined ? newData.maxAdInteractionSeconds : 30,
                adPageInnerClickPercentage: newData.adPageInnerClickPercentage !== undefined ? newData.adPageInnerClickPercentage : 50,
                playbackSpeed2xPercentage: newData.playbackSpeed2xPercentage !== undefined ? newData.playbackSpeed2xPercentage : 0,
                enableSubtitlesPercentage: newData.enableSubtitlesPercentage !== undefined ? newData.enableSubtitlesPercentage : 0,
                volumeChangePercentage: newData.volumeChangePercentage !== undefined ? newData.volumeChangePercentage : 10,
                lastEvolved: now 
              };
              fs.writeFileSync(CONFIG_PATH, JSON.stringify(configJson, null, 2));
            } catch (err) { console.error('Global Evolve Error:', err); }
          }
        }
      }

      if (changed) {
        fs.writeFileSync(PERSONALITIES_PATH, JSON.stringify(data, null, 4));
      }
      return data;
    } catch (e) { return {}; }
  })

  ipcMain.handle('write-personalities', async (_, data) => {
    try {
      fs.writeFileSync(PERSONALITIES_PATH, JSON.stringify(data, null, 4));
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  })

  ipcMain.handle('ask-ai-personality', async (_, { description, provider, apiKey }) => {
    try {
      const systemPrompt = "You are a behavioral psychologist. Convert a personality description into 18 bot parameters. Return ONLY JSON with fields: \"adSkipPercentage\" (0-100), \"watchScrollPercentage\" (0-100), \"suggestedVideoClickPercentage\" (0-100), \"behaviorChangeFrequency\" (0-120), \"searchPage1ScrollChance\" (0-100), \"searchPage2ScrollChance\" (0-100), \"searchPage3ScrollChance\" (0-100), \"searchPage4ScrollChance\" (0-100), \"searchPage5ScrollChance\" (0-100), \"likePercentage\" (0-100), \"commentPercentage\" (0-100), \"minWatchMinutes\" (1-10), \"maxWatchMinutes\" (2-30), \"minAdInteractionSeconds\" (5-30), \"maxAdInteractionSeconds\" (10-120), \"adPageInnerClickPercentage\" (0-100), \"playbackSpeed2xPercentage\" (0-100), \"enableSubtitlesPercentage\" (0-100). No markdown, no extra text.";
      const userPrompt = `Personality: ${description}`;
      
      const content = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.7 });
      const jsonStr = content.replace(/```json|```/g, '');
      return JSON.parse(jsonStr);
    } catch (e) {
      console.error('AI Personality Error:', e);
      return { error: e.message };
    }
  })

  ipcMain.handle('ask-ai-random-weights', async (_, { provider, apiKey }) => {
    try {
      const systemPrompt = "You are a statistics expert. Generate realistic device and browser market share percentages representing how popular devices and browsers enter Google search (real-world market share statistics). Return ONLY JSON with fields: \"device\" containing keys \"desktop\", \"mac\", \"linux\", \"mobile\", and \"browser\" containing keys \"chrome\", \"firefox\", \"safari\", \"edge\". The percentages in \"device\" must sum to 100, and percentages in \"browser\" must sum to 100. Return ONLY JSON. No markdown, no extra text.";
      const userPrompt = "Generate realistic Google traffic market shares for devices and browsers.";
      
      const content = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.5 });
      const jsonStr = content.replace(/```json|```/g, '');
      return JSON.parse(jsonStr);
    } catch (e) {
      console.error('AI Random Weights Error:', e);
      return { error: e.message };
    }
  })

  ipcMain.handle('ask-ai-adjust-settings', async (_, { currentSettings, instructions, provider, apiKey }) => {
    try {
      const systemPrompt = "You are an expert settings optimizer for a web browsing bot dashboard.\n" +
        "Your task is to take the bot settings and adjust them based on the user's instructions.\n" +
        "You must return ONLY a JSON object containing any updated sections from the following schema:\n" +
        "{\n" +
        "  \"automation\": { ... },\n" +
        "  \"clickQuota\": { ... },\n" +
        "  \"scheduler\": { ... },\n" +
        "  \"randomWeights\": { ... }\n" +
        "}\n\n" +
        "Rules for adjusting each section:\n" +
        "1. automation (behavioral settings):\n" +
        "   - adSkipPercentage, watchScrollPercentage, suggestedVideoClickPercentage, behaviorChangeFrequency (0-120), searchPage1ScrollChance to searchPage5ScrollChance, likePercentage, commentPercentage, minWatchMinutes, maxWatchMinutes, minAdInteractionSeconds, maxAdInteractionSeconds, adPageInnerClickPercentage, playbackSpeed2xPercentage, enableSubtitlesPercentage, volumeChangePercentage, adWatchPercentage, adClickPercentage, commentMode ('ai' or 'custom'), customComments (array of strings).\n" +
        "   - Ensure adSkipPercentage + adWatchPercentage + adClickPercentage sum to exactly 100.\n" +
        "   - Ensure maxWatchMinutes >= minWatchMinutes and maxAdInteractionSeconds >= minAdInteractionSeconds.\n" +
        "2. clickQuota (ad click limits):\n" +
        "   - daily: number (e.g. 2)\n" +
        "   - weekly: number (usually daily * 7)\n" +
        "   - monthly: number (usually daily * 30)\n" +
        "3. scheduler:\n" +
        "   - targetMonthlyAdClicks: number\n" +
        "   - maxConcurrentProfiles: number\n" +
        "4. randomWeights:\n" +
        "   - device: desktop, mac, linux, mobile (percentages, must sum to 100)\n" +
        "   - browser: chrome, firefox, safari, edge (percentages, must sum to 100)\n\n" +
        "Ensure all other parameters are preserved or logically updated. Return ONLY the adjusted JSON block. Do not include markdown code block wrappers (like ```json), explanations, or extra text.";

      // We extract only the adjustable sections to feed to the AI to prevent exposing other keys/paths
      const relevantConfig = {
        automation: currentSettings.automation || {},
        clickQuota: currentSettings.clickQuota || {},
        scheduler: currentSettings.scheduler || {},
        randomWeights: currentSettings.randomWeights || {}
      };

      const userPrompt = `Current configuration:\n${JSON.stringify(relevantConfig, null, 2)}\n\nUser Instructions:\n${instructions}`;

      const response = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.7 });
      const cleanJson = response.replace(/```json|```/g, '').trim();
      const adjustedSettings = JSON.parse(cleanJson);

      // Merge and write back to browser-config.json
      if (fs.existsSync(CONFIG_PATH)) {
        const configJson = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        
        if (adjustedSettings.automation) {
          configJson.automation = { ...configJson.automation, ...adjustedSettings.automation };
        }
        if (adjustedSettings.clickQuota) {
          configJson.clickQuota = { ...configJson.clickQuota, ...adjustedSettings.clickQuota };
        }
        if (adjustedSettings.scheduler) {
          configJson.scheduler = { ...configJson.scheduler, ...adjustedSettings.scheduler };
        }
        if (adjustedSettings.randomWeights) {
          configJson.randomWeights = { ...configJson.randomWeights, ...adjustedSettings.randomWeights };
        }
        
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(configJson, null, 4), 'utf8');
        return { success: true, updatedConfig: configJson };
      }
      return { success: false, error: 'Config file not found' };
    } catch (e) {
      console.error('AI Settings Adjustment Error:', e);
      return { success: false, error: e.message };
    }
  })

  ipcMain.handle('check-ai-balance', async (_, { provider, apiKey }) => {
    try {
      const prov = (provider || 'deepseek').toLowerCase();
      if (prov !== 'deepseek') {
        return { success: false, error: `Balance check is not supported for ${provider} API keys.` };
      }
      if (!apiKey) {
        return { success: false, error: 'API Key is required to check balance.' };
      }
      
      const response = await fetch('https://api.deepseek.com/user/balance', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      });
      
      if (!response.ok) {
        const errText = await response.text();
        return { success: false, error: `API Error: ${response.statusText} (${response.status}). ${errText}` };
      }
      
      const data = await response.json();
      return { success: true, balance: data };
    } catch (e) {
      console.error('Check AI Balance Error:', e);
      return { success: false, error: e.message };
    }
  })

  // AI Schedule generator
  ipcMain.handle('ask-ai-schedule', async (_, { personality, device, browser, timezone, season, targetMonthlyAdClicks, provider, apiKey, profileId, family }) => {
    try {
      let resolvedDevice = device || 'random';
      let resolvedBrowser = browser || 'random';

      if (profileId && family) {
        const profilePath = path.join(PROFILES_BASE_DIR, family, profileId);
        const fingerprintPath = path.join(profilePath, 'fingerprint.json');
        if (fs.existsSync(fingerprintPath)) {
          try {
            const fp = JSON.parse(fs.readFileSync(fingerprintPath, 'utf8'));
            const ua = fp.fingerprint?.navigator?.userAgent || '';
            if (/Android|iPhone|iPad|Mobile/i.test(ua)) {
              resolvedDevice = 'mobile';
            } else if (/Macintosh|Mac OS X/i.test(ua)) {
              resolvedDevice = 'mac';
            } else if (/Linux/i.test(ua)) {
              resolvedDevice = 'linux';
            } else {
              resolvedDevice = 'desktop';
            }

            if (/Edg\//i.test(ua)) {
              resolvedBrowser = 'edge';
            } else if (/Firefox\//i.test(ua)) {
              resolvedBrowser = 'firefox';
            } else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) {
              resolvedBrowser = 'safari';
            } else {
              resolvedBrowser = 'chrome';
            }
          } catch (e) {
            console.error('Error parsing existing fingerprint for AI scheduling:', e);
          }
        }
      }

      let schedulerSettings = {}
      try {
        if (fs.existsSync(CONFIG_PATH)) {
          const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
          schedulerSettings = config.scheduler || {}
        }
      } catch (e) {}

      const enabledTasks = []
      if (schedulerSettings.youtubeEnabled !== false) enabledTasks.push('YouTube Search & watch')
      if (schedulerSettings.googleEnabled !== false) enabledTasks.push('Google organic search')
      if (schedulerSettings.gmailEnabled !== false) enabledTasks.push('Gmail/Google Email Reading (checking inbox, newsletters, organic link clicks)')
      if (schedulerSettings.youtubeTargetEnabled !== false) enabledTasks.push('Targeted YouTube Search & watch')
      if (schedulerSettings.youtubeChannelEnabled !== false) enabledTasks.push('Custom Channel watch journey')
      if (schedulerSettings.youtubePlaylistEnabled !== false) enabledTasks.push('Custom Playlist watch journey')
      if (schedulerSettings.articleEnabled !== false) enabledTasks.push('general portal news/articles browsing')
      if (schedulerSettings.websiteEnabled !== false) enabledTasks.push('dynamic website visits')
      if (schedulerSettings.customWebsiteEnabled !== false) enabledTasks.push('custom website ad journey (visit configured website, interact deeply and click ads)')

      // Fallback in case they unchecked everything
      if (enabledTasks.length === 0) {
        enabledTasks.push('YouTube Search & watch', 'Google organic search')
      }

      const currentDateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      
      const systemPrompt = `You are a master bot scheduler. Your job is to analyze a profile's timezone and determine its exact local current climate/geographical season as of the current date: ${currentDateStr}.
For example:
- Timezone 'Africa/Lagos' in May corresponds to Nigeria's 'Rainy (Wet) Season' (runs from April to October).
- Timezone 'Africa/Lagos' in December corresponds to Nigeria's 'Dry Season (Harmattan)' (runs from November to March).
- Timezone 'Australia/Sydney' in May corresponds to 'Autumn' (Southern hemisphere).
- Timezone 'America/New_York' in May corresponds to 'Spring' (Northern hemisphere).

Based on the timezone, identify its local climate patterns, current active season, and return a JSON object with:
1. "detectedSeason": A string naming the exact detected climate season (e.g. 'Rainy Season', 'Dry Season (Harmattan)', 'Summer', 'Autumn').
2. "tasks": An array of daily activities (4-6 strategically spaced tasks) matching the personality, device, timezone, and local season. Task objects must have "time" (HH:MM), "task" (string), "desc" (string explaining action customized to this detected season), and "active" (boolean).

CRITICAL SCHEDULING RULES:
- Allowed Tasks: You MUST ONLY select tasks from the following enabled task types: ${enabledTasks.join(', ')}. Do not schedule any task types not in this list.
- Personality & Device Alignment: All activities and simulated human behaviors must strictly match the profile's specific personality footprint, hobbies, and hardware device details.
- Organic Ad-Clicks: Spaced throughout the weekly schedules, insert highly realistic, human-mimicked organic daily ad-clicking operations so that a target of exactly ${targetMonthlyAdClicks || 10} monthly ad clicks per profile is reached naturally and spread out evenly across the month.
- High Variety and Uniqueness: To ensure maximum organic stealth, you MUST randomize the exact scheduled times (varying start times by random offsets like 09:12, 14:37, 21:03 rather than round numbers) and vary the choice of search terms and activities. Never return the same schedule twice.
- Strict Exclusions: Under no circumstances should 'test.js' ever be assigned, referred to, or returned as a task, script name, or activity for any profile schedule.

Return ONLY the raw JSON object. No markdown wrappers, no extra explanation.`;

      const userPrompt = `Personality details: ${JSON.stringify(personality)}. Device footprint: ${resolvedDevice}. Browser footprint: ${resolvedBrowser}. Timezone: ${timezone}. Chosen Season fallback: ${season}. Randomization Seed: ${Math.random().toString(36).substring(7)}.${new Date().getTime()}.`;

      const content = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.95 });
      const jsonStr = content.replace(/```json|```/g, '');
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        return {
          detectedSeason: season || 'Auto-detected',
          tasks: parsed
        };
      }
      return parsed;
    } catch (e) {
      console.error('AI Scheduler Error:', e);
      return { error: e.message };
    }
  })

  // --- Google Drive Sync IPC Handlers & Background Scheduler ---
  let syncIntervalTimer = null

  async function scheduleGoogleDriveSync() {
    if (syncIntervalTimer) {
      clearInterval(syncIntervalTimer)
      syncIntervalTimer = null
    }

    try {
      if (!fs.existsSync(CONFIG_PATH)) return
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      const settings = config.googleDriveSync

      if (!settings || !settings.enabled || settings.interval === 'manually') {
        console.log('[Google Sync Scheduler] Sync is disabled or set to manually.')
        return
      }

      const intervals = {
        '1h': 60 * 60 * 1000,
        '6h': 6 * 60 * 60 * 1000,
        '12h': 12 * 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000
      }

      const ms = intervals[settings.interval]
      if (!ms) return

      console.log(`[Google Sync Scheduler] Scheduled auto background sync every ${settings.interval} (${ms} ms).`)

      syncIntervalTimer = setInterval(async () => {
        console.log(`[Google Sync Scheduler] Triggering automatic background sync...`)
        const syncResult = await runSync({
          ...settings,
          projectRoot: resolveAppPath('')
        })

        if (syncResult.success) {
          try {
            const currentConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
            if (!currentConfig.googleDriveSync) {
              currentConfig.googleDriveSync = {}
            }
            currentConfig.googleDriveSync.lastSync = syncResult.lastSync
            
            // Calculate next sync
            const nextSyncDate = new Date(Date.now() + ms)
            currentConfig.googleDriveSync.nextSync = nextSyncDate.toISOString()

            fs.writeFileSync(CONFIG_PATH, JSON.stringify(currentConfig, null, 4), 'utf8')
            console.log(`[Google Sync Scheduler] Auto-sync success. Next sync scheduled at ${nextSyncDate.toLocaleString()}`)
          } catch (err) {
            console.error('Failed to update scheduled lastSync/nextSync timestamps:', err)
          }
        } else {
          console.error('[Google Sync Scheduler] Background sync failed:', syncResult.error)
        }
      }, ms)
    } catch (e) {
      console.error('Failed to initialize Google Drive Sync scheduler:', e)
    }
  }

  // Handle manual/immediate sync trigger
  ipcMain.handle('google-drive-sync', async (_, currentSettings) => {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return { success: false, error: 'Config file not found' }
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      const settings = currentSettings || config.googleDriveSync || {
        enabled: false,
        mode: 'local',
        localPath: '',
        serviceAccountJson: '',
        accessToken: '',
        interval: 'manually',
        syncScope: { config: true, personalities: true, proxies: true, fingerprints: true, profiles: false }
      }

      const res = await runSync({
        ...settings,
        projectRoot: resolveAppPath('')
      })

      if (res.success) {
        config.googleDriveSync = {
          ...settings,
          lastSync: res.lastSync
        }
        
        // Calculate next sync if enabled
        if (settings.enabled && settings.interval !== 'manually') {
          const intervals = {
            '1h': 60 * 60 * 1000,
            '6h': 6 * 60 * 60 * 1000,
            '12h': 12 * 60 * 60 * 1000,
            '24h': 24 * 60 * 60 * 1000,
            '7d': 7 * 24 * 60 * 60 * 1000
          }
          const ms = intervals[settings.interval]
          if (ms) {
            config.googleDriveSync.nextSync = new Date(Date.now() + ms).toISOString()
          }
        } else {
          config.googleDriveSync.nextSync = null
        }

        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8')
      }

      return res
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Handle manual restore/import from cloud
  ipcMain.handle('google-drive-restore', async (_, currentSettings) => {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return { success: false, error: 'Config file not found' }
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      
      const settings = currentSettings || config.googleDriveSync || {
        enabled: false,
        mode: 'local',
        localPath: '',
        serviceAccountJson: '',
        accessToken: '',
        interval: 'manually',
        syncScope: { config: true, personalities: true, proxies: true, fingerprints: true, profiles: false }
      }

      const res = await runRestore({
        ...settings,
        projectRoot: resolveAppPath('')
      })

      return res
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  // Get Google Drive Sync settings
  ipcMain.handle('get-google-drive-settings', async () => {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return null
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      return config.googleDriveSync || {
        enabled: false,
        mode: 'local',
        localPath: '',
        serviceAccountJson: '',
        accessToken: '',
        interval: 'manually',
        syncScope: { config: true, personalities: true, proxies: true, fingerprints: true, profiles: false },
        lastSync: null,
        nextSync: null
      }
    } catch (error) {
      console.error('Error fetching Google Drive settings:', error)
      return null
    }
  })

  // Save Google Drive Sync settings and reschedule background scheduler
  ipcMain.handle('save-google-drive-settings', async (_, newSettings) => {
    try {
      if (!fs.existsSync(CONFIG_PATH)) return { success: false, error: 'Config file not found' }
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      
      config.googleDriveSync = {
        ...config.googleDriveSync,
        ...newSettings
      }

      // Calculate next sync if enabled
      if (newSettings.enabled && newSettings.interval !== 'manually') {
        const intervals = {
          '1h': 60 * 60 * 1000,
          '6h': 6 * 60 * 60 * 1000,
          '12h': 12 * 60 * 60 * 1000,
          '24h': 24 * 60 * 60 * 1000,
          '7d': 7 * 24 * 60 * 60 * 1000
        }
        const ms = intervals[newSettings.interval]
        if (ms) {
          config.googleDriveSync.nextSync = new Date(Date.now() + ms).toISOString()
        }
      } else {
        config.googleDriveSync.nextSync = null
      }

      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8')
      
      // Reschedule background thread immediately
      scheduleGoogleDriveSync()
      
      return { success: true, nextSync: config.googleDriveSync.nextSync }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })

  const GLOBAL_NETWORK_USAGE_PATH = resolveAppPath('global_network_usage.json')

  function normalizeUsageData(usage) {
    if (!usage || typeof usage !== 'object') usage = {}
    const totalBytes = usage.totalBytes || 0
    const downloadBytes = usage.downloadBytes !== undefined ? usage.downloadBytes : totalBytes
    const uploadBytes = usage.uploadBytes || 0
    const requests = usage.requests || 0
    const limitBytes = usage.limitBytes !== undefined ? usage.limitBytes : null

    const direct = usage.direct || {
      totalBytes: (usage.proxy?.totalBytes ? Math.max(0, totalBytes - usage.proxy.totalBytes) : totalBytes),
      downloadBytes: (usage.proxy?.downloadBytes ? Math.max(0, downloadBytes - usage.proxy.downloadBytes) : downloadBytes),
      uploadBytes: (usage.proxy?.uploadBytes ? Math.max(0, uploadBytes - usage.proxy.uploadBytes) : uploadBytes),
      requests: (usage.proxy?.requests ? Math.max(0, requests - usage.proxy.requests) : requests),
      domains: {}
    }

    const proxy = usage.proxy || {
      totalBytes: 0,
      downloadBytes: 0,
      uploadBytes: 0,
      requests: 0,
      domains: {},
      proxies: {}
    }

    const domains = {}
    if (usage.domains && typeof usage.domains === 'object') {
      for (const [dom, domData] of Object.entries(usage.domains)) {
        domains[dom] = {
          bytes: domData.bytes || domData.totalBytes || 0,
          directBytes: domData.directBytes !== undefined ? domData.directBytes : 0,
          proxyBytes: domData.proxyBytes !== undefined ? domData.proxyBytes : 0,
          downloadBytes: domData.downloadBytes || domData.bytes || 0,
          uploadBytes: domData.uploadBytes || 0,
          requests: domData.requests || 0,
          limitBytes: domData.limitBytes !== undefined ? domData.limitBytes : null
        }
      }
    }

    return {
      totalBytes,
      downloadBytes,
      uploadBytes,
      requests,
      limitBytes,
      direct,
      proxy,
      domains,
      lastUpdated: usage.lastUpdated || new Date().toISOString()
    }
  }

  function readGlobalUsage() {
    if (fs.existsSync(GLOBAL_NETWORK_USAGE_PATH)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(GLOBAL_NETWORK_USAGE_PATH, 'utf8'))
        return normalizeUsageData(parsed)
      } catch (e) {}
    }
    return {
      totalBytes: 0,
      downloadBytes: 0,
      uploadBytes: 0,
      requests: 0,
      limitBytes: null,
      direct: { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {} },
      proxy: { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {}, proxies: {} },
      domains: {},
      history: {},
      sessions: [],
      lastUpdated: new Date().toISOString()
    }
  }

  function getProfilesUsageInternal() {
    const result = []
    if (!fs.existsSync(PROFILES_BASE_DIR)) return result

    const families = fs.readdirSync(PROFILES_BASE_DIR).filter(f => safeIsDirectory(path.join(PROFILES_BASE_DIR, f)))
    for (const fam of families) {
      const familyPath = path.join(PROFILES_BASE_DIR, fam)
      const profiles = fs.readdirSync(familyPath).filter(f => safeIsDirectory(path.join(familyPath, f)))
      for (const p of profiles) {
        const profilePath = path.join(familyPath, p)
        const usagePath = path.join(profilePath, 'network_usage.json')
        const proxyPath = path.join(profilePath, 'proxy.json')
        let usage = { totalBytes: 0, limitBytes: null, domains: {} }
        let proxyConfig = null

        if (fs.existsSync(usagePath)) {
          try {
            usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'))
          } catch (err) {}
        }
        if (fs.existsSync(proxyPath)) {
          try {
            proxyConfig = JSON.parse(fs.readFileSync(proxyPath, 'utf8'))
          } catch (err) {}
        }

        result.push({
          id: p,
          family: fam,
          usage: normalizeUsageData(usage),
          proxy: proxyConfig
        })
      }
    }
    return result
  }

  ipcMain.handle('get-profiles-network-usage', async () => {
    try {
      return getProfilesUsageInternal()
    } catch (e) {
      console.error('Error fetching profiles network usage:', e)
      return []
    }
  })

  ipcMain.handle('get-network-summary', async () => {
    try {
      const profiles = getProfilesUsageInternal()
      let globalData = readGlobalUsage()

      // If global stats are empty but profiles have data, blend them so user sees full historical totals
      const profilesTotal = profiles.reduce((acc, p) => acc + (p.usage?.totalBytes || 0), 0)
      if (globalData.totalBytes < profilesTotal) {
        profiles.forEach(p => {
          const u = p.usage
          if (!u) return
          globalData.totalBytes += (u.totalBytes || 0)
          globalData.downloadBytes += (u.downloadBytes || 0)
          globalData.uploadBytes += (u.uploadBytes || 0)
          globalData.requests += (u.requests || 0)

          if (u.direct) {
            globalData.direct.totalBytes += (u.direct.totalBytes || 0)
            globalData.direct.downloadBytes += (u.direct.downloadBytes || 0)
            globalData.direct.uploadBytes += (u.direct.uploadBytes || 0)
            globalData.direct.requests += (u.direct.requests || 0)
            Object.entries(u.direct.domains || {}).forEach(([d, dd]) => {
              if (!globalData.direct.domains[d]) globalData.direct.domains[d] = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0 }
              globalData.direct.domains[d].totalBytes += (dd.totalBytes || dd.bytes || 0)
              globalData.direct.domains[d].downloadBytes += (dd.downloadBytes || 0)
              globalData.direct.domains[d].uploadBytes += (dd.uploadBytes || 0)
              globalData.direct.domains[d].requests += (dd.requests || 0)
            })
          }

          if (u.proxy) {
            globalData.proxy.totalBytes += (u.proxy.totalBytes || 0)
            globalData.proxy.downloadBytes += (u.proxy.downloadBytes || 0)
            globalData.proxy.uploadBytes += (u.proxy.uploadBytes || 0)
            globalData.proxy.requests += (u.proxy.requests || 0)
            Object.entries(u.proxy.domains || {}).forEach(([d, dd]) => {
              if (!globalData.proxy.domains[d]) globalData.proxy.domains[d] = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0 }
              globalData.proxy.domains[d].totalBytes += (dd.totalBytes || dd.bytes || 0)
              globalData.proxy.domains[d].downloadBytes += (dd.downloadBytes || 0)
              globalData.proxy.domains[d].uploadBytes += (dd.uploadBytes || 0)
              globalData.proxy.domains[d].requests += (dd.requests || 0)
            })
            Object.entries(u.proxy.proxies || {}).forEach(([pkey, pval]) => {
              if (!globalData.proxy.proxies[pkey]) globalData.proxy.proxies[pkey] = { ...pval, totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0 }
              globalData.proxy.proxies[pkey].totalBytes += (pval.totalBytes || 0)
              globalData.proxy.proxies[pkey].downloadBytes += (pval.downloadBytes || 0)
              globalData.proxy.proxies[pkey].uploadBytes += (pval.uploadBytes || 0)
              globalData.proxy.proxies[pkey].requests += (pval.requests || 0)
            })
          }
        })
      }

      return {
        success: true,
        data: {
          profiles,
          global: globalData
        }
      }
    } catch (e) {
      console.error('Error fetching network summary:', e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('set-profile-network-limits', async (_, { id, family, limitBytes, domainLimits }) => {
    try {
      const profilePath = path.join(PROFILES_BASE_DIR, family, id)
      const usagePath = path.join(profilePath, 'network_usage.json')
      let usage = { totalBytes: 0, limitBytes: null, domains: {} }
      
      if (!fs.existsSync(profilePath)) {
        fs.mkdirSync(profilePath, { recursive: true })
      }
      
      if (fs.existsSync(usagePath)) {
        try {
          usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'))
        } catch (err) {}
      }
      
      usage.limitBytes = limitBytes !== undefined ? limitBytes : null
      
      // Sync domain limits
      if (domainLimits) {
        if (!usage.domains) usage.domains = {}
        for (const [domain, limit] of Object.entries(domainLimits)) {
          if (!usage.domains[domain]) {
            usage.domains[domain] = { bytes: 0, directBytes: 0, proxyBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, limitBytes: null }
          }
          usage.domains[domain].limitBytes = limit
        }
      }
      
      fs.writeFileSync(usagePath, JSON.stringify(usage, null, 4), 'utf8')
      return { success: true }
    } catch (e) {
      console.error(e)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('clear-profile-network-usage', async (_, { id, family, scope = 'all' }) => {
    try {
      const profilePath = path.join(PROFILES_BASE_DIR, family, id)
      const usagePath = path.join(profilePath, 'network_usage.json')
      
      if (fs.existsSync(usagePath)) {
        try {
          const usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'))
          if (scope === 'all') {
            usage.totalBytes = 0
            usage.downloadBytes = 0
            usage.uploadBytes = 0
            usage.requests = 0
            usage.direct = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {} }
            usage.proxy = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {}, proxies: {} }
            if (usage.domains) {
              for (const d of Object.keys(usage.domains)) {
                usage.domains[d].bytes = 0
                usage.domains[d].directBytes = 0
                usage.domains[d].proxyBytes = 0
                usage.domains[d].downloadBytes = 0
                usage.domains[d].uploadBytes = 0
                usage.domains[d].requests = 0
              }
            }
          } else if (scope === 'direct') {
            const dirBytes = usage.direct?.totalBytes || 0
            usage.totalBytes = Math.max(0, (usage.totalBytes || 0) - dirBytes)
            usage.direct = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {} }
            if (usage.domains) {
              for (const d of Object.keys(usage.domains)) {
                usage.domains[d].directBytes = 0
                usage.domains[d].bytes = usage.domains[d].proxyBytes || 0
              }
            }
          } else if (scope === 'proxy') {
            const proxBytes = usage.proxy?.totalBytes || 0
            usage.totalBytes = Math.max(0, (usage.totalBytes || 0) - proxBytes)
            usage.proxy = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {}, proxies: {} }
            if (usage.domains) {
              for (const d of Object.keys(usage.domains)) {
                usage.domains[d].proxyBytes = 0
                usage.domains[d].bytes = usage.domains[d].directBytes || 0
              }
            }
          }
          fs.writeFileSync(usagePath, JSON.stringify(usage, null, 4), 'utf8')
        } catch (err) {}
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('clear-all-profiles-network-usage', async (_, { scope = 'all' } = {}) => {
    try {
      if (!fs.existsSync(PROFILES_BASE_DIR)) return { success: true }
      
      const families = fs.readdirSync(PROFILES_BASE_DIR).filter(f => safeIsDirectory(path.join(PROFILES_BASE_DIR, f)))
      for (const fam of families) {
        const familyPath = path.join(PROFILES_BASE_DIR, fam)
        const profiles = fs.readdirSync(familyPath).filter(f => safeIsDirectory(path.join(familyPath, f)))
        for (const p of profiles) {
          const profilePath = path.join(familyPath, p)
          const usagePath = path.join(profilePath, 'network_usage.json')
          
          if (fs.existsSync(usagePath)) {
            try {
              const usage = JSON.parse(fs.readFileSync(usagePath, 'utf8'))
              if (scope === 'all') {
                usage.totalBytes = 0
                usage.downloadBytes = 0
                usage.uploadBytes = 0
                usage.requests = 0
                usage.direct = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {} }
                usage.proxy = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {}, proxies: {} }
                if (usage.domains) {
                  for (const d of Object.keys(usage.domains)) {
                    usage.domains[d].bytes = 0
                    usage.domains[d].directBytes = 0
                    usage.domains[d].proxyBytes = 0
                    usage.domains[d].downloadBytes = 0
                    usage.domains[d].uploadBytes = 0
                    usage.domains[d].requests = 0
                  }
                }
              } else if (scope === 'direct') {
                const dirBytes = usage.direct?.totalBytes || 0
                usage.totalBytes = Math.max(0, (usage.totalBytes || 0) - dirBytes)
                usage.direct = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {} }
              } else if (scope === 'proxy') {
                const proxBytes = usage.proxy?.totalBytes || 0
                usage.totalBytes = Math.max(0, (usage.totalBytes || 0) - proxBytes)
                usage.proxy = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {}, proxies: {} }
              }
              fs.writeFileSync(usagePath, JSON.stringify(usage, null, 4), 'utf8')
            } catch (err) {}
          }
        }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('clear-global-network-usage', async (_, { scope = 'all' } = {}) => {
    try {
      if (fs.existsSync(GLOBAL_NETWORK_USAGE_PATH)) {
        try {
          if (scope === 'all') {
            fs.unlinkSync(GLOBAL_NETWORK_USAGE_PATH)
          } else {
            const raw = JSON.parse(fs.readFileSync(GLOBAL_NETWORK_USAGE_PATH, 'utf8'))
            if (scope === 'direct') {
              raw.totalBytes = Math.max(0, (raw.totalBytes || 0) - (raw.direct?.totalBytes || 0))
              raw.direct = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {} }
            } else if (scope === 'proxy') {
              raw.totalBytes = Math.max(0, (raw.totalBytes || 0) - (raw.proxy?.totalBytes || 0))
              raw.proxy = { totalBytes: 0, downloadBytes: 0, uploadBytes: 0, requests: 0, domains: {}, proxies: {} }
            }
            fs.writeFileSync(GLOBAL_NETWORK_USAGE_PATH, JSON.stringify(raw, null, 2), 'utf8')
          }
        } catch (e) {}
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('export-bandwidth-report', async () => {
    try {
      const profiles = getProfilesUsageInternal()
      const globalData = readGlobalUsage()
      return {
        success: true,
        report: {
          generatedAt: new Date().toISOString(),
          global: globalData,
          profiles
        }
      }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  function runQuery(dbPath, query, params = []) {
    return new Promise((resolve) => {
      const readerPath = resolveAppPath('db_reader.js')
      let output = ''
      let errorOutput = ''
      
      const child = spawnNode(readerPath, [dbPath, query, JSON.stringify(params)])
      
      child.stdout.on('data', (data) => { output += data.toString() })
      child.stderr.on('data', (data) => { errorOutput += data.toString() })
      
      child.on('close', (code) => {
        try {
          if (errorOutput && !output) {
            resolve({ success: false, error: JSON.parse(errorOutput).error })
          } else {
            resolve(JSON.parse(output))
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to parse database output: ' + e.message })
        }
      })
    })
  }

  ipcMain.handle('get-predictor-teams', async (_, { dbPath }) => {
    try {
      const leaguesResult = await runQuery(dbPath, "SELECT DISTINCT league_name FROM betting_analytics ORDER BY league_name");
      const teamsResult = await runQuery(dbPath, "SELECT DISTINCT team FROM (SELECT home_team AS team FROM betting_analytics UNION SELECT away_team AS team FROM betting_analytics) ORDER BY team");
      
      return {
        success: true,
        leagues: leaguesResult.success ? leaguesResult.data.map(r => r.league_name) : [],
        teams: teamsResult.success ? teamsResult.data.map(r => r.team) : []
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-team-matchups', async (_, { dbPath, homeTeam, awayTeam }) => {
    try {
      const h2hResult = await runQuery(dbPath, 
        "SELECT * FROM betting_analytics WHERE (home_team = ? AND away_team = ?) OR (home_team = ? AND away_team = ?) ORDER BY id DESC",
        [homeTeam, awayTeam, awayTeam, homeTeam]
      );
      
      const homeRecentResult = await runQuery(dbPath,
        "SELECT * FROM betting_analytics WHERE home_team = ? OR away_team = ? ORDER BY id DESC LIMIT 10",
        [homeTeam, homeTeam]
      );
      
      const awayRecentResult = await runQuery(dbPath,
        "SELECT * FROM betting_analytics WHERE home_team = ? OR away_team = ? ORDER BY id DESC LIMIT 10",
        [awayTeam, awayTeam]
      );
      
      // Check if league_standings table exists
      const tableCheck = await runQuery(dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name='league_standings'");
      const standingsExist = tableCheck.success && tableCheck.data.length > 0;

      let latestSeasonName = null;
      let homeStanding = null;
      let awayStanding = null;
      let homeHistory = null;
      let awayHistory = null;

      if (standingsExist) {
        const latestSeasonRes = await runQuery(dbPath,
          "SELECT season_name FROM league_standings ORDER BY id DESC LIMIT 1"
        );
        latestSeasonName = (latestSeasonRes.success && latestSeasonRes.data.length > 0) 
          ? latestSeasonRes.data[0].season_name 
          : null;

        if (latestSeasonName) {
          const homeStandingRes = await runQuery(dbPath,
            "SELECT * FROM league_standings WHERE season_name = ? AND team_name = ?",
            [latestSeasonName, homeTeam]
          );
          const awayStandingRes = await runQuery(dbPath,
            "SELECT * FROM league_standings WHERE season_name = ? AND team_name = ?",
            [latestSeasonName, awayTeam]
          );
          if (homeStandingRes.success && homeStandingRes.data.length > 0) homeStanding = homeStandingRes.data[0];
          if (awayStandingRes.success && awayStandingRes.data.length > 0) awayStanding = awayStandingRes.data[0];
        }

        const homeHistoryRes = await runQuery(dbPath,
          "SELECT AVG(position) as avgPosition, AVG(points) as avgPoints, AVG(goal_difference) as avgGd, COUNT(*) as seasonsCount FROM league_standings WHERE team_name = ?",
          [homeTeam]
        );
        const awayHistoryRes = await runQuery(dbPath,
          "SELECT AVG(position) as avgPosition, AVG(points) as avgPoints, AVG(goal_difference) as avgGd, COUNT(*) as seasonsCount FROM league_standings WHERE team_name = ?",
          [awayTeam]
        );

        if (homeHistoryRes.success && homeHistoryRes.data.length > 0) homeHistory = homeHistoryRes.data[0];
        if (awayHistoryRes.success && awayHistoryRes.data.length > 0) awayHistory = awayHistoryRes.data[0];
      }

      let mlPrediction = null;
      try {
        const mlRes = await runMLPredict(dbPath, homeTeam, awayTeam);
        if (mlRes && mlRes.success) {
          mlPrediction = mlRes;
        }
      } catch (err) {
        console.error("Error generating ML prediction:", err.message);
      }

      return {
        success: true,
        h2hMatches: h2hResult.success ? h2hResult.data : [],
        homeRecent: homeRecentResult.success ? homeRecentResult.data : [],
        awayRecent: awayRecentResult.success ? awayRecentResult.data : [],
        homeStanding,
        awayStanding,
        homeHistory,
        awayHistory,
        latestSeasonName,
        mlPrediction
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('optimize-ml-weights', async (_, { dbPath }) => {
    try {
      const res = await runMLOptimize(dbPath);
      return res;
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('launch-new-window', async (_, options) => {
    try {
      createWindow(options);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('predict-matchup-ai', async (_, { homeTeam, awayTeam, h2hData, homeStats, awayStats, homeStanding, awayStanding, homeHistory, awayHistory, latestSeasonName, h2hMatches, homeRecent, awayRecent, provider, apiKey, mlPrediction, minStake }) => {
    try {
      const systemPrompt = "You are an advanced Football Prediction System powered by Machine Learning and statistical models. " +
        "Your task is to analyze historical head-to-head records, recent match performance metrics, league standings, and long-term team forms to generate a detailed predictive analysis.\n" +
        "The prompt includes predictions from an advanced offline Machine Learning model (Poisson-Elo Blended). You must analyze and explain the ML model's forecast (Poisson xG, Elo ratings, scoreline probabilities, goal markets, handicaps, Half-Time stats, and kickoff time trends) and let it work hand-in-hand with your tactical/contextual analysis to explain how the final conclusion was reached.\n\n" +
        "Structure your response beautifully in Markdown with sections:\n" +
        "1. ### 📊 MATCHUP OVERVIEW: Home Team vs Away Team relative strengths and league table context.\n" +
        "2. ### 🤖 MACHINE LEARNING MODEL ANALYSIS: Explain the ML model's predictions (Win/Draw/Loss probabilities, Poisson xG expected goals, Elo Ratings, and top scorelines).\n" +
        "3. ### 🎯 PROBABILISTIC FORECAST: home win %, draw %, away win % blending the ML model and your contextual/tactical reasons.\n" +
        "4. ### ⚽ PREDICTED SCORELINE & GOAL DISTRIBUTION: predicted score and goals over/under suggestions based on Poisson averages.\n" +
        "5. ### 📈 HIGH-YIELD MARKET SUGGESTIONS: best value markets (e.g. GG, Over 1.5, Double Chance).\n" +
        "6. ### 🧠 SYNTHESIS & CONCLUSION: Detailed analysis of how the ML model and tactical context work hand-in-hand to arrive at the final conclusion.\n" +
        "7. ### 🎯 AI RECOMMENDATION & BEST BET: A clear, explicit, and definitive recommendation of the single best bet/market (Full-Time FT or Half-Time HT outcome, GG/NG, handicaps, or Over/Under thresholds), including overall confidence percentage and clear tactical/statistical rationale referencing HT/FT trends and kickoff time trends.\n" +
        "8. ### 💰 STAKING STRATEGY & RISK MANAGEMENT: A custom betting strategy with exact monetary stake suggestions built as multipliers of the user's Minimum Stake (Minimum Stake = " + (minStake || 1000) + "). Provide a clean breakdown of: Low-Risk (e.g. 2.0x minStake), Medium-Risk (e.g. 1.0x minStake), and High-Risk/Value (e.g. 0.5x minStake) bets. Tell the user exactly how much currency to place on each suggestion based on their input.\n" +
        "9. ### 🚪 LOSS MITIGATION & HEDGING STRATEGY (WAY OUT): A detailed live-hedging or exit strategy giving the user a way out in case the bet begins to fail. Provide concrete triggers based on game time or live events (e.g. 'If Team A is not leading by minute 60, cash out or place X amount on Double Chance to cover', 'If it remains 0-0 at half-time, hedge on Under 1.5 live goals', etc.) to help the user minimize losses.\n\n" +
        "Be precise, professional, and base your prediction strictly on the provided data. Do not make up facts.";

      let standingsInfo = '';
      if (homeStanding && awayStanding) {
        standingsInfo = `League Table Standings (Latest Season: ${latestSeasonName}):\n` +
          `- ${homeTeam}: Position ${homeStanding.position}/${homeStanding.played} matches, Points: ${homeStanding.points}, Goal Diff: ${homeStanding.goal_difference} (W:${homeStanding.won} D:${homeStanding.drawn} L:${homeStanding.lost})\n` +
          `- ${awayTeam}: Position ${awayStanding.position}/${awayStanding.played} matches, Points: ${awayStanding.points}, Goal Diff: ${awayStanding.goal_difference} (W:${awayStanding.won} D:${awayStanding.drawn} L:${awayStanding.lost})\n\n`;
      }
      
      let historyInfo = '';
      if (homeHistory && awayHistory && homeHistory.seasonsCount > 0) {
        historyInfo = `Long-term Historical League Standings (over ${homeHistory.seasonsCount} seasons):\n` +
          `- ${homeTeam}: Avg Position: ${Number(homeHistory.avgPosition).toFixed(1)}, Avg Points: ${Number(homeHistory.avgPoints).toFixed(1)}, Avg Goal Diff: ${Number(homeHistory.avgGd).toFixed(1)}\n` +
          `- ${awayTeam}: Avg Position: ${Number(awayHistory.avgPosition).toFixed(1)}, Avg Points: ${Number(awayHistory.avgPoints).toFixed(1)}, Avg Goal Diff: ${Number(awayHistory.avgGd).toFixed(1)}\n\n`;
      }

      let h2hMatchesList = '';
      if (h2hMatches && h2hMatches.length > 0) {
        h2hMatchesList = `Recent Head-to-Head Individual Match Results (Fixtures):\n` +
          h2hMatches.slice(0, 10).map(m => {
            const timeStr = m.match_time ? `[${m.match_time}] ` : '';
            return `- ${timeStr}${m.home_team} ${m.home_score} - ${m.away_score} ${m.away_team} (Result: ${m.match_result}, HT: ${m.ht_home_score ?? '?'}:${m.ht_away_score ?? '?'})`;
          }).join('\n') + '\n\n';
      }

      let homeRecentList = '';
      if (homeRecent && homeRecent.length > 0) {
        homeRecentList = `${homeTeam} Recent 10 Match Results (Fixtures):\n` +
          homeRecent.slice(0, 10).map(m => {
            const isHome = m.home_team === homeTeam;
            const outcome = m.match_result === 'Draw' ? 'Draw' : ((m.match_result === 'Home' && isHome) || (m.match_result === 'Away' && !isHome) ? 'Win' : 'Loss');
            return `- ${m.home_team} ${m.home_score} - ${m.away_score} ${m.away_team} (${outcome}, HT: ${m.ht_home_score ?? '?'}:${m.ht_away_score ?? '?'})`;
          }).join('\n') + '\n\n';
      }

      let awayRecentList = '';
      if (awayRecent && awayRecent.length > 0) {
        awayRecentList = `${awayTeam} Recent 10 Match Results (Fixtures):\n` +
          awayRecent.slice(0, 10).map(m => {
            const isHome = m.home_team === awayTeam;
            const outcome = m.match_result === 'Draw' ? 'Draw' : ((m.match_result === 'Home' && isHome) || (m.match_result === 'Away' && !isHome) ? 'Win' : 'Loss');
            return `- ${m.home_team} ${m.home_score} - ${m.away_score} ${m.away_team} (${outcome}, HT: ${m.ht_home_score ?? '?'}:${m.ht_away_score ?? '?'})`;
          }).join('\n') + '\n\n';
      }

      let mlInfo = '';
      if (mlPrediction && mlPrediction.success) {
        mlInfo = `Advanced Offline Machine Learning Model Forecast (Poisson-Elo Blended):\n` +
          `- Prediction Overall Confidence Score: ${mlPrediction.confidenceScore}%\n` +
          `- Blended Out-of-Sample Probability: ${homeTeam} Win: ${(mlPrediction.blended.homeWin * 100).toFixed(1)}%, Draw: ${(mlPrediction.blended.draw * 100).toFixed(1)}%, ${awayTeam} Win: ${(mlPrediction.blended.awayWin * 100).toFixed(1)}%\n` +
          `- Active Blending Weights: Poisson weight: ${(mlPrediction.weights.poissonWeight * 100).toFixed(0)}%, Elo weight: ${(mlPrediction.weights.eloWeight * 100).toFixed(0)}%\n` +
          `- Poisson Expected Goals (Full-Time FT xG): ${homeTeam} expected goals: ${mlPrediction.poisson.homeXG.toFixed(2)}, ${awayTeam} expected goals: ${mlPrediction.poisson.awayXG.toFixed(2)}\n` +
          `- Poisson Expected Goals (Half-Time HT xG): ${homeTeam} expected goals at HT: ${mlPrediction.poisson.ht.homeHT_XG.toFixed(2)}, ${awayTeam} expected goals at HT: ${mlPrediction.poisson.ht.awayHT_XG.toFixed(2)}\n` +
          `- Half-Time (HT) Match Winner Probabilities: Home Win at HT: ${(mlPrediction.poisson.ht.homeWinProb * 100).toFixed(1)}%, Draw at HT: ${(mlPrediction.poisson.ht.drawProb * 100).toFixed(1)}%, Away Win at HT: ${(mlPrediction.poisson.ht.awayWinProb * 100).toFixed(1)}%\n` +
          `- Double Chance Probabilities (FT): 1X: ${(mlPrediction.poisson.doubleChance.dc1X * 100).toFixed(1)}%, 12: ${(mlPrediction.poisson.doubleChance.dc12 * 100).toFixed(1)}%, X2: ${(mlPrediction.poisson.doubleChance.dcX2 * 100).toFixed(1)}%\n` +
          `- Draw No Bet Probabilities (FT): ${homeTeam} (DNB): ${(mlPrediction.poisson.drawNoBet.home * 100).toFixed(1)}%, ${awayTeam} (DNB): ${(mlPrediction.poisson.drawNoBet.away * 100).toFixed(1)}%\n` +
          `- Odd/Even Total Goals: Odd: ${(mlPrediction.poisson.oddProb * 100).toFixed(1)}%, Even: ${(mlPrediction.poisson.evenProb * 100).toFixed(1)}%\n` +
          `- Exact Goals Probabilities (FT):\n` +
          `  * 0 Goals: ${(mlPrediction.poisson.exactGoals.eg0 * 100).toFixed(1)}%\n` +
          `  * 1 Goal: ${(mlPrediction.poisson.exactGoals.eg1 * 100).toFixed(1)}%\n` +
          `  * 2 Goals: ${(mlPrediction.poisson.exactGoals.eg2 * 100).toFixed(1)}%\n` +
          `  * 3 Goals: ${(mlPrediction.poisson.exactGoals.eg3 * 100).toFixed(1)}%\n` +
          `  * 4 Goals: ${(mlPrediction.poisson.exactGoals.eg4 * 100).toFixed(1)}%\n` +
          `  * 5 Goals: ${(mlPrediction.poisson.exactGoals.eg5 * 100).toFixed(1)}%\n` +
          `  * 6+ Goals: ${(mlPrediction.poisson.exactGoals.eg6Plus * 100).toFixed(1)}%\n` +
          `- Poisson Probability Goal Markets (Full-Time FT):\n` +
          `  * Over 0.5 Goals: ${(mlPrediction.poisson.over05 * 100).toFixed(1)}%\n` +
          `  * Over 1.5 Goals: ${(mlPrediction.poisson.over15 * 100).toFixed(1)}%\n` +
          `  * Over 2.5 Goals: ${(mlPrediction.poisson.over25 * 100).toFixed(1)}%\n` +
          `  * Over 3.5 Goals: ${(mlPrediction.poisson.over35 * 100).toFixed(1)}%\n` +
          `  * Over 4.5 Goals: ${(mlPrediction.poisson.over45 * 100).toFixed(1)}%\n` +
          `  * Over 5.5 Goals: ${(mlPrediction.poisson.over55 * 100).toFixed(1)}%\n` +
          `  * Both Teams to Score (GG): ${(mlPrediction.poisson.gg * 100).toFixed(1)}%\n` +
          `  * No Goal (NG): ${(mlPrediction.poisson.ng * 100).toFixed(1)}%\n` +
          `- First Goal Market:\n` +
          `  * ${homeTeam} Scores First: ${(mlPrediction.poisson.firstGoal.home * 100).toFixed(1)}%\n` +
          `  * ${awayTeam} Scores First: ${(mlPrediction.poisson.firstGoal.away * 100).toFixed(1)}%\n` +
          `  * No Goal: ${(mlPrediction.poisson.firstGoal.none * 100).toFixed(1)}%\n` +
          `- Home Total Goals (FT):\n` +
          `  * Over 0.5: ${(mlPrediction.poisson.homeTotalGoals.over05 * 100).toFixed(1)}%, Under 0.5: ${(mlPrediction.poisson.homeTotalGoals.under05 * 100).toFixed(1)}%\n` +
          `  * Over 1.5: ${(mlPrediction.poisson.homeTotalGoals.over15 * 100).toFixed(1)}%, Under 1.5: ${(mlPrediction.poisson.homeTotalGoals.under15 * 100).toFixed(1)}%\n` +
          `  * Over 2.5: ${(mlPrediction.poisson.homeTotalGoals.over25 * 100).toFixed(1)}%, Under 2.5: ${(mlPrediction.poisson.homeTotalGoals.under25 * 100).toFixed(1)}%\n` +
          `- Away Total Goals (FT):\n` +
          `  * Over 0.5: ${(mlPrediction.poisson.awayTotalGoals.over05 * 100).toFixed(1)}%, Under 0.5: ${(mlPrediction.poisson.awayTotalGoals.under05 * 100).toFixed(1)}%\n` +
          `  * Over 1.5: ${(mlPrediction.poisson.awayTotalGoals.over15 * 100).toFixed(1)}%, Under 1.5: ${(mlPrediction.poisson.awayTotalGoals.under15 * 100).toFixed(1)}%\n` +
          `  * Over 2.5: ${(mlPrediction.poisson.awayTotalGoals.over25 * 100).toFixed(1)}%, Under 2.5: ${(mlPrediction.poisson.awayTotalGoals.under25 * 100).toFixed(1)}%\n` +
          `- Exact Goals (FT):\n` +
          `  * Home Exact: 0: ${(mlPrediction.poisson.homeExactGoals.eg0 * 100).toFixed(1)}%, 1: ${(mlPrediction.poisson.homeExactGoals.eg1 * 100).toFixed(1)}%, 2: ${(mlPrediction.poisson.homeExactGoals.eg2 * 100).toFixed(1)}%, 3: ${(mlPrediction.poisson.homeExactGoals.eg3 * 100).toFixed(1)}%, 4+: ${(mlPrediction.poisson.homeExactGoals.eg4Plus * 100).toFixed(1)}%\n` +
          `  * Away Exact: 0: ${(mlPrediction.poisson.awayExactGoals.eg0 * 100).toFixed(1)}%, 1: ${(mlPrediction.poisson.awayExactGoals.eg1 * 100).toFixed(1)}%, 2: ${(mlPrediction.poisson.awayExactGoals.eg2 * 100).toFixed(1)}%, 3: ${(mlPrediction.poisson.awayExactGoals.eg3 * 100).toFixed(1)}%, 4+: ${(mlPrediction.poisson.awayExactGoals.eg4Plus * 100).toFixed(1)}%\n` +
          `- Teams to Score (FT):\n` +
          `  * Both Teams: ${(mlPrediction.poisson.teamsToScore.both * 100).toFixed(1)}%\n` +
          `  * Only Home: ${(mlPrediction.poisson.teamsToScore.onlyHome * 100).toFixed(1)}%\n` +
          `  * Only Away: ${(mlPrediction.poisson.teamsToScore.onlyAway * 100).toFixed(1)}%\n` +
          `  * None (0-0): ${(mlPrediction.poisson.teamsToScore.none * 100).toFixed(1)}%\n` +
          `- Poisson Probability Goal Markets (Half-Time HT):\n` +
          `  * HT Over 0.5 Goals: ${(mlPrediction.poisson.ht.over05 * 100).toFixed(1)}%\n` +
          `  * HT Over 1.5 Goals: ${(mlPrediction.poisson.ht.over15 * 100).toFixed(1)}%\n` +
          `  * HT Over 2.5 Goals: ${(mlPrediction.poisson.ht.over25 * 100).toFixed(1)}%\n` +
          `  * HT Over 3.5 Goals: ${(mlPrediction.poisson.ht.over35 * 100).toFixed(1)}%\n` +
          `  * HT Over 4.5 Goals: ${(mlPrediction.poisson.ht.over45 * 100).toFixed(1)}%\n` +
          `  * HT Over 5.5 Goals: ${(mlPrediction.poisson.ht.over55 * 100).toFixed(1)}%\n` +
          `  * HT Both Teams to Score (HT GG): ${(mlPrediction.poisson.ht.gg * 100).toFixed(1)}%\n` +
          `  * HT No Goal (HT NG): ${(mlPrediction.poisson.ht.ng * 100).toFixed(1)}%\n` +
          `- HT Double Chance: 1X at HT: ${(mlPrediction.poisson.ht.doubleChance.dc1X * 100).toFixed(1)}%, 12 at HT: ${(mlPrediction.poisson.ht.doubleChance.dc12 * 100).toFixed(1)}%, X2 at HT: ${(mlPrediction.poisson.ht.doubleChance.dcX2 * 100).toFixed(1)}%\n` +
          `- 3-Way Handicap Markets (FT):\n` +
          `  * ${homeTeam} (-2): Home Win: ${(mlPrediction.poisson.handicap3Way.minus2.home * 100).toFixed(1)}%, Draw: ${(mlPrediction.poisson.handicap3Way.minus2.draw * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.handicap3Way.minus2.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (-1): Home Win: ${(mlPrediction.poisson.handicap3Way.minus1.home * 100).toFixed(1)}%, Draw: ${(mlPrediction.poisson.handicap3Way.minus1.draw * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.handicap3Way.minus1.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+1): Home Win: ${(mlPrediction.poisson.handicap3Way.plus1.home * 100).toFixed(1)}%, Draw: ${(mlPrediction.poisson.handicap3Way.plus1.draw * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.handicap3Way.plus1.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+2): Home Win: ${(mlPrediction.poisson.handicap3Way.plus2.home * 100).toFixed(1)}%, Draw: ${(mlPrediction.poisson.handicap3Way.plus2.draw * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.handicap3Way.plus2.away * 100).toFixed(1)}%\n` +
          `- Asian Handicap Markets (FT):\n` +
          `  * ${homeTeam} (-1.5) / ${awayTeam} (+1.5): Home Win: ${(mlPrediction.poisson.asianHandicap.minus1_5.home * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.asianHandicap.minus1_5.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+1.5) / ${awayTeam} (-1.5): Home Win: ${(mlPrediction.poisson.asianHandicap.plus1_5.home * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.asianHandicap.plus1_5.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (-1.25) / ${awayTeam} (+1.25): Home Win: ${(mlPrediction.poisson.asianHandicap.minus1_25.home * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.asianHandicap.minus1_25.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+1.25) / ${awayTeam} (-1.25): Home Win: ${(mlPrediction.poisson.asianHandicap.plus1_25.home * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.asianHandicap.plus1_25.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (-1.75) / ${awayTeam} (+1.75): Home Win: ${(mlPrediction.poisson.asianHandicap.minus1_75.home * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.asianHandicap.minus1_75.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+1.75) / ${awayTeam} (-1.75): Home Win: ${(mlPrediction.poisson.asianHandicap.plus1_75.home * 100).toFixed(1)}%, Away Win: ${(mlPrediction.poisson.asianHandicap.plus1_75.away * 100).toFixed(1)}%\n` +
          `- HT Asian Handicap Markets:\n` +
          `  * ${homeTeam} (-0.5) / ${awayTeam} (+0.5) HT: Home Win HT: ${(mlPrediction.poisson.ht.asianHandicap.minus0_5.home * 100).toFixed(1)}%, Away Win HT: ${(mlPrediction.poisson.ht.asianHandicap.minus0_5.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+0.5) / ${awayTeam} (-0.5) HT: Home Win HT: ${(mlPrediction.poisson.ht.asianHandicap.plus0_5.home * 100).toFixed(1)}%, Away Win HT: ${(mlPrediction.poisson.ht.asianHandicap.plus0_5.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (-0.75) / ${awayTeam} (+0.75) HT: Home Win HT: ${(mlPrediction.poisson.ht.asianHandicap.minus0_75.home * 100).toFixed(1)}%, Away Win HT: ${(mlPrediction.poisson.ht.asianHandicap.minus0_75.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+0.75) / ${awayTeam} (-0.75) HT: Home Win HT: ${(mlPrediction.poisson.ht.asianHandicap.plus0_75.home * 100).toFixed(1)}%, Away Win HT: ${(mlPrediction.poisson.ht.asianHandicap.plus0_75.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (-1.5) / ${awayTeam} (+1.5) HT: Home Win HT: ${(mlPrediction.poisson.ht.asianHandicap.minus1_5.home * 100).toFixed(1)}%, Away Win HT: ${(mlPrediction.poisson.ht.asianHandicap.minus1_5.away * 100).toFixed(1)}%\n` +
          `  * ${homeTeam} (+1.5) / ${awayTeam} (-1.5) HT: Home Win HT: ${(mlPrediction.poisson.ht.asianHandicap.plus1_5.home * 100).toFixed(1)}%, Away Win HT: ${(mlPrediction.poisson.ht.asianHandicap.plus1_5.away * 100).toFixed(1)}%\n` +
          `- Halftime/Fulltime Probabilities:\n` +
          `  * 1/1: ${(mlPrediction.poisson.halftimeFulltime.htft11 * 100).toFixed(1)}%, 1/X: ${(mlPrediction.poisson.halftimeFulltime.htft1X * 100).toFixed(1)}%, 1/2: ${(mlPrediction.poisson.halftimeFulltime.htft12 * 100).toFixed(1)}%\n` +
          `  * X/1: ${(mlPrediction.poisson.halftimeFulltime.htftX1 * 100).toFixed(1)}%, X/X: ${(mlPrediction.poisson.halftimeFulltime.htftXX * 100).toFixed(1)}%, X/2: ${(mlPrediction.poisson.halftimeFulltime.htftX2 * 100).toFixed(1)}%\n` +
          `  * 2/1: ${(mlPrediction.poisson.halftimeFulltime.htft21 * 100).toFixed(1)}%, 2/X: ${(mlPrediction.poisson.halftimeFulltime.htft2X * 100).toFixed(1)}%, 2/2: ${(mlPrediction.poisson.halftimeFulltime.htft22 * 100).toFixed(1)}%\n` +
          `- Highest Scoring Half: 1st Half: ${(mlPrediction.poisson.highestScoringHalf.firstHalf * 100).toFixed(1)}%, 2nd Half: ${(mlPrediction.poisson.highestScoringHalf.secondHalf * 100).toFixed(1)}%, Equal: ${(mlPrediction.poisson.highestScoringHalf.equal * 100).toFixed(1)}%\n` +
          `- Kickoff Time Performance Trends (Daytime kickoff hour < 17, Nighttime hour >= 17):\n` +
          `  * ${homeTeam} (Day matches): Played: ${mlPrediction.poisson.kickoffStats.homeDay.played}, Win Rate: ${mlPrediction.poisson.kickoffStats.homeDay.winRate.toFixed(1)}%, Avg Goals: ${mlPrediction.poisson.kickoffStats.homeDay.avgGoals.toFixed(2)}\n` +
          `  * ${homeTeam} (Night matches): Played: ${mlPrediction.poisson.kickoffStats.homeNight.played}, Win Rate: ${mlPrediction.poisson.kickoffStats.homeNight.winRate.toFixed(1)}%, Avg Goals: ${mlPrediction.poisson.kickoffStats.homeNight.avgGoals.toFixed(2)}\n` +
          `  * ${awayTeam} (Day matches): Played: ${mlPrediction.poisson.kickoffStats.awayDay.played}, Win Rate: ${mlPrediction.poisson.kickoffStats.awayDay.winRate.toFixed(1)}%, Avg Goals: ${mlPrediction.poisson.kickoffStats.awayDay.avgGoals.toFixed(2)}\n` +
          `  * ${awayTeam} (Night matches): Played: ${mlPrediction.poisson.kickoffStats.awayNight.played}, Win Rate: ${mlPrediction.poisson.kickoffStats.awayNight.winRate.toFixed(1)}%, Avg Goals: ${mlPrediction.poisson.kickoffStats.awayNight.avgGoals.toFixed(2)}\n` +
          `- Elo Rating System (momentum rating): ${homeTeam} rating: ${mlPrediction.elo ? Math.round(mlPrediction.elo.homeElo) : '1500'}, ${awayTeam} rating: ${mlPrediction.elo ? Math.round(mlPrediction.elo.awayElo) : '1500'}\n` +
          `- Elo Win Expectancy Probability: ${homeTeam} win: ${mlPrediction.elo ? (mlPrediction.elo.homeEloWinProb * 100).toFixed(1) : '50.0'}%, ${awayTeam} win: ${mlPrediction.elo ? (mlPrediction.elo.awayEloWinProb * 100).toFixed(1) : '50.0'}%\n` +
          `- Top 5 Predicted Full-Time Correct Scorelines: ${mlPrediction.poisson.correctScoresList.slice(0, 5).map(s => `${s.score} (${(s.prob * 100).toFixed(1)}%)`).join(', ')}\n` +
          `- Top 3 Predicted Half-Time Correct Scorelines: ${mlPrediction.poisson.ht.topScorelines.map(s => `${s.score} (${(s.prob * 100).toFixed(1)}%)`).join(', ')}\n\n`;
      }

      const userPrompt = `Analysis Request:\n` +
        `Home Team: ${homeTeam}\n` +
        `Away Team: ${awayTeam}\n\n` +
        mlInfo +
        standingsInfo +
        historyInfo +
        h2hMatchesList +
        homeRecentList +
        awayRecentList +
        `Head-to-Head Statistics:\n` +
        `- Total Matches Played: ${h2hData.totalMatches}\n` +
        `- Home Team Wins: ${h2hData.homeWins}\n` +
        `- Away Team Wins: ${h2hData.awayWins}\n` +
        `- Draws: ${h2hData.draws}\n` +
        `- Avg Goals Per Match: ${h2hData.avgGoals.toFixed(2)}\n\n` +
        `Home Team recent form:\n` +
        `- Win Rate: ${homeStats.winRate.toFixed(1)}%\n` +
        `- Over 1.5 Rate: ${homeStats.over15Rate.toFixed(1)}%\n` +
        `- Over 2.5 Rate: ${homeStats.over25Rate.toFixed(1)}%\n` +
        `- BTTS (GG) Rate: ${homeStats.ggRate.toFixed(1)}%\n` +
        `- Avg Goals Scored: ${homeStats.avgGoalsScored.toFixed(2)}\n` +
        `- Avg Goals Conceded: ${homeStats.avgGoalsConceded.toFixed(2)}\n\n` +
        `Away Team recent form:\n` +
        `- Win Rate: ${awayStats.winRate.toFixed(1)}%\n` +
        `- Over 1.5 Rate: ${awayStats.over15Rate.toFixed(1)}%\n` +
        `- Over 2.5 Rate: ${awayStats.over25Rate.toFixed(1)}%\n` +
        `- BTTS (GG) Rate: ${awayStats.ggRate.toFixed(1)}%\n` +
        `- Avg Goals Scored: ${awayStats.avgGoalsScored.toFixed(2)}\n` +
        `- Avg Goals Conceded: ${awayStats.avgGoalsConceded.toFixed(2)}\n\n` +
        `Please analyze these statistics and generate the forecasting report.`;

      const prediction = await callAI({ provider, apiKey, systemPrompt, userPrompt, temperature: 0.6 });
      return { success: true, prediction };
    } catch (e) {
      console.error('AI Matchup Predictor Error:', e);
      return { success: false, error: e.message };
    }
  });

  // ─── Backtest: list available seasons ──────────────────────────────────────
  ipcMain.handle('get-backtest-seasons', async (_, { dbPath }) => {
    try {
      const result = await runQuery(dbPath,
        "SELECT DISTINCT season_name FROM betting_analytics ORDER BY season_name",
        []
      );
      return { success: true, seasons: result.success ? result.data.map(r => r.season_name) : [] };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ─── Backtest: run Poisson+Elo blind prediction on every match in a target season ─
  ipcMain.handle('run-backtest', async (_, { dbPath, seasonName }) => {
    try {
      const result = await runMLBacktest(dbPath, seasonName);
      return result;
    } catch (e) {
      console.error('Backtest Error:', e);
      return { success: false, error: e.message };
    }
  });

  // ─── Backtest: export detailed PDF report ──────────────────────────────────
  ipcMain.handle('print-backtest-pdf', async (_, { html, filename }) => {
    try {
      // Write HTML to a temp file so loadFile works reliably for large docs
      const tmpPath = path.join(os.tmpdir(), `backtest_report_${Date.now()}.html`);
      fs.writeFileSync(tmpPath, html, 'utf8');

      // Create hidden BrowserWindow to render the HTML
      const pdfWin = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: false, contextIsolation: false }
      });

      await pdfWin.loadFile(tmpPath);
      // Give it a moment to fully render fonts & layout
      await new Promise(resolve => setTimeout(resolve, 800));

      const pdfBuffer = await pdfWin.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        marginsType: 0,
        margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
        landscape: false
      });

      pdfWin.close();
      fs.unlinkSync(tmpPath); // clean up temp file

      // Ask user where to save
      const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Save Backtest Report',
        defaultPath: filename || 'backtest_report.pdf',
        filters: [{ name: 'PDF Documents', extensions: ['pdf'] }]
      });

      if (canceled || !filePath) return { success: false, canceled: true };

      fs.writeFileSync(filePath, pdfBuffer);
      return { success: true, filePath };
    } catch (e) {
      console.error('PDF Export Error:', e);
      return { success: false, error: e.message };
    }
  });

  // ─── Pattern Analysis: run deep pattern mining on the DB ───────────────────
  ipcMain.handle('analyse-patterns', async (_, { dbPath }) => {
    try {
      const result = await runMLAnalysePatterns(dbPath);
      return result;
    } catch (e) {
      console.error('Pattern Analysis Error:', e);
      return { success: false, error: e.message };
    }
  });

  // ─── Live Season Predictor IPC Handlers ──────────────────────────────────────
  ipcMain.handle('scrape-live-season', async (_, { dbPath, isHeadless }) => {
    try {
      const result = await runMLScrapeLiveSeason(dbPath, isHeadless);
      return result;
    } catch (e) {
      console.error('Scrape Live Season Error:', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-live-predictions', async (_, { dbPath }) => {
    try {
      const result = await runMLGetLivePredictions(dbPath);
      return result;
    } catch (e) {
      console.error('Get Live Predictions Error:', e);
      return { success: false, error: e.message };
    }
  });

  // ─── Predictor Betting Signals Collector IPC Handlers ───────────────────────
  try {
    const collector = getSignalCollector();
    if (collector) {
      try {
        const p = resolveAppPath('bot_settings.json');
        if (fs.existsSync(p)) {
          const settings = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (settings.signalServer) {
            collector.updateConfig(settings.signalServer);
          }
        }
      } catch (e) {}

      collector.on('state-changed', (state) => {
        broadcastToWindows('signal-collector-status', state);
      });
      collector.on('new-picks', (picks) => {
        broadcastToWindows('signal-collector-new-picks', picks);
      });
      collector.on('settled-picks', (settled) => {
        broadcastToWindows('signal-collector-settled-picks', settled);
      });
      collector.on('signals-updated', (state) => {
        broadcastToWindows('signal-collector-update', state);
      });
      collector.on('log', (entry) => {
        broadcastToWindows('signal-collector-log', entry);
      });

      if (collector.config.autoConnect) {
        collector.start();
      }
    }
  } catch (err) {
    console.error('[Signal Collector Init Error]:', err.message);
  }

  ipcMain.handle('get-signal-collector-state', async () => {
    try {
      const c = getSignalCollector();
      if (!c) return { success: false, error: 'Signal Collector service not available' };
      return { success: true, ...c.getState() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('update-signal-collector-config', async (_, newConfig) => {
    try {
      const c = getSignalCollector();
      if (!c) return { success: false, error: 'Signal Collector service not available' };
      c.updateConfig(newConfig);

      try {
        const p = resolveAppPath('bot_settings.json');
        let settings = {};
        if (fs.existsSync(p)) {
          settings = JSON.parse(fs.readFileSync(p, 'utf8'));
        }
        settings.signalServer = { ...(settings.signalServer || {}), ...newConfig };
        fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf8');
      } catch (e) {}

      return { success: true, ...c.getState() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('connect-signal-collector', async () => {
    try {
      const c = getSignalCollector();
      if (!c) return { success: false, error: 'Signal Collector service not available' };
      c.start();
      return { success: true, ...c.getState() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('disconnect-signal-collector', async () => {
    try {
      const c = getSignalCollector();
      if (!c) return { success: false, error: 'Signal Collector service not available' };
      c.stop();
      return { success: true, ...c.getState() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('test-signal-server', async (_, { serverUrl, apiKey }) => {
    try {
      const c = getSignalCollector();
      if (!c) return { success: false, error: 'Signal Collector service not available' };
      const res = await c.testConnection(serverUrl, apiKey);
      return res;
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('clear-collected-signals', async () => {
    try {
      const c = getSignalCollector();
      if (!c) return { success: false, error: 'Signal Collector service not available' };
      c.clearHistory();
      return { success: true, ...c.getState() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('export-collected-signals', async (_, { format }) => {
    try {
      const c = getSignalCollector();
      if (!c) return { success: false, error: 'Signal Collector service not available' };
      const res = c.exportSignals(format || 'json');
      return res;
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // ─── 1xBet Bet Executor IPC Handlers ─────────────────────────────────────
  const executorController = createExecutorController(path.dirname(resolveAppPath('sportybet_executor.js')));
  let betExecutorProcess = null;
  let betExecutorStatus = { running: false, profileId: null, startTime: null, pid: null };

  ipcMain.handle('get-bet-executor-config', async () => {
    try {
      const p = resolveAppPath('bot_settings.json');
      let settings = {};
      if (fs.existsSync(p)) {
        try { settings = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
      }
      const activePlatform = settings.betExecutorPlatform || (settings.betExecutor && settings.betExecutor.platform) || 'sportybet';
      const sportybetObj = {
        targetUrl: 'https://www.sportybet.com/ng/virtual/',
        loginIdentifier: '',
        password: '',
        profileId: 'profile_1793749723076',
        family: 'sportybet',
        headless: false,
        stakeAmount: 10,
        currency: 'NGN',
        autoBet: true,
        stopLoss: 5000,
        stopLossEnabled: true,
        takeProfit: 10000,
        takeProfitEnabled: true,
        stakeMode: 'martingale_1_5',
        stakingScaling: 'uncapped',
        selectedTiers: ['safest', 'high_chance', 'high_risk'],
        selectedSignalTypes: ['all'],
        selectedStrategy: 'ai_best_pick',
        minOdds: 0,
        maxOdds: 0,
        minConfidence: 0,
        teamSearch: '',
        ...(settings.betExecutor || {}),
        ...(settings.sportybetExecutor || {})
      };
      const betExecutorObj = {
        targetUrl: 'https://1xbet.com',
        loginType: 'phone',
        loginIdentifier: '',
        password: '',
        profileId: 'temp',
        family: 'DEFAULT',
        headless: false,
        stakeAmount: 60,
        stakePercentage: 2,
        stakeMode: 'martingale_1_5',
        currency: 'NGN',
        startingBankroll: 30000,
        stakingScaling: 'uncapped',
        stopLoss: 10000,
        stopLossEnabled: true,
        takeProfit: 10000,
        takeProfitEnabled: true,
        selectedTiers: ['safest', 'high_chance'],
        selectedSignalTypes: ['all'],
        selectedStrategy: 'ai_best_pick',
        minOdds: 0,
        maxOdds: 0,
        minConfidence: 0,
        teamSearch: '',
        autoBet: false,
        ...(settings.betExecutor || {})
      };
      const activeSpread = activePlatform === 'sportybet' ? sportybetObj : betExecutorObj;
      return {
        ...activeSpread,
        platform: activePlatform,
        sportybet: sportybetObj,
        betExecutor: betExecutorObj
      };
    } catch (e) {
      return {
        platform: 'sportybet',
        sportybet: {
          targetUrl: 'https://www.sportybet.com/ng/virtual/',
          loginIdentifier: '',
          password: '',
          profileId: 'profile_1793749723076',
          family: 'sportybet',
          headless: false,
          stakeAmount: 10,
          currency: 'NGN',
          autoBet: true
        },
        betExecutor: {
          targetUrl: 'https://1xbet.com',
          loginType: 'phone',
          loginIdentifier: '',
          password: '',
          profileId: 'temp',
          family: 'DEFAULT',
          headless: false,
          stakeAmount: 60,
          autoBet: false
        }
      };
    }
  });

  ipcMain.handle('save-bet-executor-config', async (_, configData) => {
    try {
      const p = resolveAppPath('bot_settings.json');
      let settings = {};
      if (fs.existsSync(p)) {
        try { settings = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
      }
      const platform = (configData.platform || settings.betExecutorPlatform || 'sportybet').toLowerCase();
      settings.betExecutorPlatform = platform;
      const sharedStrategyFields = {};
      for (const k of ['stakeMode', 'stakingScaling', 'selectedTiers', 'selectedSignalTypes', 'selectedStrategy', 'minOdds', 'maxOdds', 'minConfidence', 'teamSearch']) {
        if (configData[k] !== undefined) sharedStrategyFields[k] = configData[k];
      }
      if (platform === 'sportybet') {
        settings.sportybetExecutor = { ...(settings.sportybetExecutor || {}), ...configData };
        settings.betExecutor = { ...(settings.betExecutor || {}), ...sharedStrategyFields, platform };
      } else {
        settings.betExecutor = { ...(settings.betExecutor || {}), ...configData };
        settings.sportybetExecutor = { ...(settings.sportybetExecutor || {}), ...sharedStrategyFields, platform };
      }
      fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf8');
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('start-bet-executor', async (_, options = {}) => {
    const currentStatus = await executorController.status(betExecutorProcess, true);
    if (currentStatus.running) {
      return { success: false, error: 'A Bet Executor process is already running. Please stop it first.', status: currentStatus };
    }

    try {
      const p = resolveAppPath('bot_settings.json');
      let settings = {};
      if (fs.existsSync(p)) {
        try { settings = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
      }
      const { resolveExecutorStartOptions } = nodeRequire(resolveAppPath('utils/executor_settings.js'));
      options = resolveExecutorStartOptions(settings, options);
      const platform = options.platform;
      settings.betExecutorPlatform = platform;
      if (platform === 'sportybet') {
        settings.sportybetExecutor = { ...(settings.sportybetExecutor || {}), ...options };
      } else {
        settings.betExecutor = { ...(settings.betExecutor || {}), ...options };
      }
      fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf8');

      const managedStart = await executorController.startManaged(platform);
      if (managedStart) {
        betExecutorStatus = managedStart.status;
        broadcastToWindows('bet-executor-status', betExecutorStatus);
        return managedStart;
      }

      let scriptPath;
      let profilePath;
      let childArgs = [];
      const platformDisplayName = platform === 'sportybet' ? 'SportyBet' : '1xBet';
      let isPermanent = true;

      if (platform === 'sportybet') {
        scriptPath = resolveAppPath('sportybet_executor.js');
        const familyName = options.family || 'sportybet';
        const profileId = options.profileId || 'profile_1793749723076';
        profilePath = path.join(PROFILES_BASE_DIR, familyName, profileId);
        if (!fs.existsSync(profilePath)) {
          fs.mkdirSync(profilePath, { recursive: true });
          broadcastToWindows('profiles-updated');
        }
        childArgs = [
          `--user-data-dir=${profilePath}`,
          `--headless=${!!options.headless}`,
          `--phone=${options.phone || options.loginIdentifier || ''}`,
          `--password=${options.password || ''}`,
          `--stake=${options.stakeAmount || 10}`,
          `--profile=${profileId}`,
          `--family=${familyName}`,
          `--currency=NGN`,
          `--stake-mode=${options.stakeMode || 'fixed'}`,
          `--stake-percent=${options.stakePercentage !== undefined ? options.stakePercentage : 2}`,
          `--starting-bankroll=${options.startingBankroll || 15000}`,
          `--staking-scaling=${options.stakingScaling || 'uncapped'}`,
          `--stop-loss=${options.stopLoss || 0}`,
          `--take-profit=${options.takeProfit || 0}`,
          `--stop-loss-enabled=${options.stopLossEnabled !== false}`,
          `--take-profit-enabled=${options.takeProfitEnabled !== false}`,
          `--auto-bet=${options.autoBet !== false}`,
          `--selected-strategy=${options.selectedStrategy || 'all'}`,
          `--min-odds=${options.minOdds || 0}`,
          `--max-odds=${options.maxOdds || 0}`,
          `--min-confidence=${options.minConfidence || 0}`,
          `--team-search=${options.teamSearch || ''}`
        ];
      } else {
        scriptPath = resolveAppPath('bet_executor.js');
        isPermanent = options.profileId && options.profileId !== 'temp';
        if (isPermanent) {
          profilePath = path.join(PROFILES_BASE_DIR, options.family || 'DEFAULT', options.profileId);
        } else {
          profilePath = path.join(os.tmpdir(), `bot-temp-executor-${Date.now()}`);
        }
        if (!fs.existsSync(profilePath)) {
          fs.mkdirSync(profilePath, { recursive: true });
        }
        childArgs = [
          `--user-data-dir=${profilePath}`,
          `--headless=${!!options.headless}`,
          `--url=${options.targetUrl || 'https://1xbet.com'}`,
          `--login-type=${options.loginType || 'phone'}`,
          `--login-id=${options.loginIdentifier || ''}`,
          `--password=${options.password || ''}`,
          `--currency=${options.currency || 'NGN'}`,
          `--stake=${options.stakeAmount || (options.currency === 'USD' ? 1 : 60)}`,
          `--stake-mode=${options.stakeMode || 'fixed'}`,
          `--stake-percent=${options.stakePercentage !== undefined ? options.stakePercentage : 2}`,
          `--starting-bankroll=${options.startingBankroll || 30000}`,
          `--staking-scaling=${options.stakingScaling || 'uncapped'}`,
          `--stop-loss=${options.stopLoss || 0}`,
          `--take-profit=${options.takeProfit || 0}`,
          `--stop-loss-enabled=${options.stopLossEnabled !== false}`,
          `--take-profit-enabled=${options.takeProfitEnabled !== false}`,
          `--auto-bet=${!!options.autoBet}`,
          `--selected-strategy=${options.selectedStrategy || 'all'}`,
          `--min-odds=${options.minOdds || 0}`,
          `--max-odds=${options.maxOdds || 0}`,
          `--min-confidence=${options.minConfidence || 0}`,
          `--team-search=${options.teamSearch || ''}`
        ];
      }

      const child = spawnNode(scriptPath, childArgs);
      betExecutorProcess = child;
      betExecutorStatus = {
        running: true,
        platform,
        profileId: isPermanent ? path.basename(profilePath) : 'Temporary Profile',
        startTime: new Date().toISOString(),
        pid: child.pid
      };

      const logger = getLogger();
      if (logger) {
        logger.info('Executor', `${platformDisplayName} Executor process launched (PID: ${child.pid}, Profile: ${path.basename(profilePath)}, Currency: NGN, Headless: ${!!options.headless})`);
      }

      broadcastToWindows('bet-executor-status', betExecutorStatus);
      broadcastToWindows('bet-executor-log', {
        type: 'system',
        text: `[Launcher] ${platformDisplayName} Executor process launched (PID: ${child.pid}, Profile: ${path.basename(profilePath)}, Headless: ${!!options.headless})`,
        time: new Date().toLocaleTimeString()
      });

      child.stdout.on('data', (data) => {
        const text = data.toString();
        broadcastToWindows('bet-executor-log', {
          type: 'stdout',
          text,
          time: new Date().toLocaleTimeString()
        });
      });

      child.stderr.on('data', (data) => {
        const text = data.toString();
        if (logger) logger.error('Executor', text.trim());
        broadcastToWindows('bet-executor-log', {
          type: 'stderr',
          text,
          time: new Date().toLocaleTimeString()
        });
      });

      child.on('close', (code) => {
        if (logger) {
          logger.info('Executor', `${platformDisplayName} Executor process exited with code ${code}`, { exitCode: code });
        }
        broadcastToWindows('bet-executor-log', {
          type: 'system',
          text: `[Launcher] ${platformDisplayName} Executor process exited with code ${code}`,
          time: new Date().toLocaleTimeString()
        });

        if (!isPermanent && fs.existsSync(profilePath)) {
          try {
            fs.rmSync(profilePath, { recursive: true, force: true });
          } catch (e) {}
        }

        betExecutorProcess = null;
        betExecutorStatus = {
          running: false,
          platform: null,
          profileId: null,
          startTime: null,
          pid: null,
          lastExitCode: code
        };
        broadcastToWindows('bet-executor-status', betExecutorStatus);
      });

      return { success: true };
    } catch (e) {
      const logger = getLogger();
      if (logger) logger.error('Executor', 'Failed to launch Bet Executor', e);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('stop-bet-executor', async () => {
    try {
      const result = await executorController.stop(betExecutorProcess);
      betExecutorProcess = null;
      betExecutorStatus = result.status;
      broadcastToWindows('bet-executor-status', result.status);
      broadcastToWindows('executor-live-status', { ...executorController.readLive(), ...result.status });
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Centralized Structured Logging System Handlers
  ipcMain.handle('get-executor-logs', async (_, limit = 200) => {
    const logger = getLogger();
    if (!logger) return [];
    return logger.getRecentLogs('executor', limit);
  });

  ipcMain.handle('open-logs-folder', async () => {
    const logger = getLogger();
    const logsDir = logger ? logger.getLogsDir() : resolveAppPath('logs');
    if (!fs.existsSync(logsDir)) {
      try {
        fs.mkdirSync(logsDir, { recursive: true });
      } catch (e) {}
    }
    shell.openPath(logsDir);
    return { success: true, path: logsDir };
  });

  ipcMain.handle('clear-subsystem-logs', async (_, sub = 'executor') => {
    const logger = getLogger();
    if (!logger) return { success: false, message: 'Logger not available' };
    return logger.clearLogs(sub);
  });

  ipcMain.handle('get-logs-dir', async () => {
    const logger = getLogger();
    return logger ? logger.getLogsDir() : resolveAppPath('logs');
  });

  ipcMain.handle('get-bet-executor-status', async () => executorController.status(betExecutorProcess));

  ipcMain.handle('get-executor-live-status', async () => ({
    ...executorController.readLive(), ...await executorController.status(betExecutorProcess)
  }));

  // Both the native and browser dashboard receive the same verified owner state.
  setInterval(async () => {
    try {
      const status = await executorController.status(betExecutorProcess);
      broadcastToWindows('bet-executor-status', status);
      broadcastToWindows('executor-live-status', { ...executorController.readLive(), ...status });
    } catch (error) {
      broadcastToWindows('bet-executor-status', { running: false, statusUnknown: true, error: error.message });
    }
  }, 1500);

  // ─────────────────────────────────────────────────────────────
  // Live Monitor & Bet Tracker Database IPC Handlers (Direct JSON streaming, zero C++ ABI dependencies)
  // ─────────────────────────────────────────────────────────────
  ipcMain.handle('get-tracker-bets', async (_, limit = 100, filterStatus = null) => {
    try {
      const p = resolveAppPath('data/tracker_summary.json');
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        let bets = data.recentBets || [];
        if (filterStatus && filterStatus !== 'ALL') {
          bets = bets.filter(b => String(b.status).toUpperCase() === String(filterStatus).toUpperCase());
        }
        return bets.slice(0, limit);
      }
    } catch (e) {}
    return [];
  });

  ipcMain.handle('get-tracker-stats', async () => {
    try {
      const p = resolveAppPath('data/tracker_summary.json');
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (data.stats) {
          return data.stats;
        }
      }
    } catch (e) {}

    return {
      totalBets: 0, pendingBets: 0, wonBets: 0, lostBets: 0, voidBets: 0,
      winRate: 0, totalStaked: 0, activeStake: 0, netProfit: 0, totalReturns: 0, roi: 0
    };
  });

  ipcMain.handle('get-tracker-balance-history', async (_, limit = 60) => {
    try {
      const p = resolveAppPath('data/tracker_summary.json');
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(data.balanceHistory) && data.balanceHistory.length > 0) {
          return data.balanceHistory.slice(0, limit);
        }
      }
    } catch (e) {}
    return [];
  });

  ipcMain.handle('export-tracker-bets', async (_, format = 'csv') => {
    try {
      const p = resolveAppPath('data/tracker_summary.json');
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const rows = data.recentBets || [];
        if (format === 'json') {
          return { success: true, data: JSON.stringify(rows, null, 2), mime: 'application/json', ext: 'json' };
        } else {
          const headers = ['id', 'placed_at', 'kickoff_time', 'round', 'home_team', 'away_team', 'market', 'selection', 'odds', 'stake', 'currency', 'status', 'profit_loss', 'ticket_id'];
          const lines = [headers.join(',')];
          for (const r of rows) {
            const line = headers.map(h => {
              let val = r[h] !== null && r[h] !== undefined ? String(r[h]) : '';
              if (val.includes(',') || val.includes('"') || val.includes('\n')) {
                val = `"${val.replace(/"/g, '""')}"`;
              }
              return val;
            });
            lines.push(line.join(','));
          }
          return { success: true, data: lines.join('\n'), mime: 'text/csv', ext: 'csv' };
        }
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
    return { success: false, error: 'No tracker summary data available' };
  });

  ipcMain.handle('sync-tracker-balance', async (_, balance, currency = 'NGN') => {
    try {
      const p = resolveAppPath('data/tracker_summary.json');
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!Array.isArray(data.balanceHistory)) data.balanceHistory = [];
        const bal = parseFloat(balance);
        if (!isNaN(bal)) {
          const last = data.balanceHistory[0];
          const delta = last ? (bal - last.balance) : 0;
          data.balanceHistory.unshift({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            balance: bal,
            currency: (currency || 'NGN').toUpperCase(),
            delta
          });
          fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
          return { success: true, data: { balance: bal, currency, delta } };
        }
      }
    } catch (e) {}
    return { success: false, error: 'Failed to record balance' };
  });

  ipcMain.handle('clear-tracker-stats', async (_, options = {}) => {
    try {
      const p = resolveAppPath('data/tracker_summary.json');
      let currentBalance = 0;
      let currentCurrency = 'NGN';

      if (fs.existsSync(p)) {
        try {
          const old = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (old.liveBalance != null && !isNaN(old.liveBalance)) {
            currentBalance = Number(old.liveBalance);
          }
          if (old.currency) currentCurrency = old.currency;
        } catch (e) {}
      }

      // Also try to read from live status if tracker_summary had no balance
      const liveStatusPath = resolveAppPath('data/executor_live_status.json');
      if (currentBalance === 0 && fs.existsSync(liveStatusPath)) {
        try {
          const ls = JSON.parse(fs.readFileSync(liveStatusPath, 'utf8'));
          if (ls.currentBalance != null && !isNaN(ls.currentBalance)) {
            currentBalance = Number(ls.currentBalance);
          }
          if (ls.currency) currentCurrency = ls.currency;
        } catch (e) {}
      }

      // Reset tracker_summary.json
      const resetSummary = {
        lastUpdated: new Date().toISOString(),
        liveBalance: currentBalance,
        currency: currentCurrency,
        stats: {
          totalBets: 0,
          pendingBets: 0,
          wonBets: 0,
          lostBets: 0,
          voidBets: 0,
          winRate: 0,
          totalStaked: 0,
          activeStake: 0,
          netProfit: 0,
          totalReturns: 0,
          roi: 0
        },
        recentBets: [],
        balanceHistory: currentBalance > 0 ? [{
          id: Date.now(),
          timestamp: new Date().toISOString(),
          balance: currentBalance,
          currency: currentCurrency,
          delta: 0
        }] : []
      };

      fs.writeFileSync(p, JSON.stringify(resetSummary, null, 2), 'utf8');

      // Also reset SQLite database
      try {
        const dbMod = require(resolveAppPath('utils/db.js'));
        if (dbMod && typeof dbMod.clearAllStatsAndBets === 'function') {
          dbMod.clearAllStatsAndBets({ preserveBalance: true });
        }
      } catch (e) {}

      // Reset executor session stats if requested (defaults to true)
      if (options.resetSession !== false && fs.existsSync(liveStatusPath)) {
        try {
          const ls = JSON.parse(fs.readFileSync(liveStatusPath, 'utf8'));
          ls.sessionProfitLoss = 0;
          ls.totalBetsPlaced = 0;
          ls.initialBalance = ls.currentBalance || currentBalance;
          ls.isTargetLimitReached = false;
          ls.limitReason = null;
          ls.lastPlacedBet = null;
          ls.updatedAt = new Date().toISOString();
          fs.writeFileSync(liveStatusPath, JSON.stringify(ls, null, 2), 'utf8');
          broadcastToWindows('executor-live-status', ls);
        } catch (e) {}
      }

      broadcastToWindows('tracker-stats-cleared', resetSummary);
      return { success: true, message: 'All statistics and history cleared successfully.' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('reset-executor-session-stats', async () => {
    try {
      const liveStatusPath = resolveAppPath('data/executor_live_status.json');
      if (fs.existsSync(liveStatusPath)) {
        const ls = JSON.parse(fs.readFileSync(liveStatusPath, 'utf8'));
        ls.sessionProfitLoss = 0;
        ls.totalBetsPlaced = 0;
        ls.initialBalance = ls.currentBalance || 0;
        ls.isTargetLimitReached = false;
        ls.limitReason = null;
        ls.updatedAt = new Date().toISOString();
        fs.writeFileSync(liveStatusPath, JSON.stringify(ls, null, 2), 'utf8');
        broadcastToWindows('executor-live-status', ls);
        return { success: true, data: ls };
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Initialize scheduler on startup (disabled - feature not needed)
  scheduleGoogleDriveSync()
  // startSchedulerEngine()


  const webPort = parseInt(process.env.WEB_PORT || '5175', 10);
  webBridge.start(webPort, join(__dirname, '../renderer'));

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
