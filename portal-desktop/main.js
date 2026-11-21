const { app, BrowserWindow, ipcMain, shell, session, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, execFile } = require('child_process');

/* ===== CHANGE THIS to the exact address where your portal (index.html) is hosted ===== */
const PORTAL_URL = 'https://exploretirur.github.io/aclms/';
/* ================================================================================== */
const PORTAL_ORIGIN = new URL(PORTAL_URL).origin;
const TALLY_PORT = 9000;
const CFG = path.join(app.getPath('userData'), 'config.json');

let win = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

const readCfg = () => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) { return {}; } };
const writeCfg = (c) => { try { fs.writeFileSync(CFG, JSON.stringify(c)); } catch (e) {} };

function fromPortal(e) {
  try { return new URL(e.senderFrame.url).origin === PORTAL_ORIGIN; } catch (x) { return false; }
}

/* ---------- talk to TallyPrime (no CORS problem here: this runs outside the browser) ---------- */
function tallyPost(xml) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(xml, 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: TALLY_PORT, method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': body.length },
      timeout: 8000
    }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(parts);
        const utf16 = raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE;
        resolve(raw.toString(utf16 ? 'utf16le' : 'utf8'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Tally did not answer')));
    req.on('error', (e) => reject(new Error('Tally not reachable: ' + e.message)));
    req.end(body);
  });
}

ipcMain.handle('tally', (e, xml) => {
  if (!fromPortal(e)) throw new Error('Not allowed');
  if (typeof xml !== 'string' || xml.length > 200000) throw new Error('Bad request');
  return tallyPost(xml);
});

/* ---------- start TallyPrime if it is not already running ---------- */
const tallyRunning = () => new Promise((resolve) => {
  execFile('tasklist', ['/FI', 'IMAGENAME eq tally.exe', '/NH'], { windowsHide: true },
    (err, out) => resolve(!err && /tally\.exe/i.test(out || '')));
});

function findTallyExe() {
  const cfg = readCfg();
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const list = [cfg.tallyPath,
    path.join(pf, 'TallyPrime', 'tally.exe'),
    path.join(pf86, 'TallyPrime', 'tally.exe'),
    path.join(pf, 'Tally', 'tally.exe'),
    'C:\\TallyPrime\\tally.exe'].filter(Boolean);
  return list.find((p) => fs.existsSync(p));
}

ipcMain.handle('launchTally', async (e) => {
  if (!fromPortal(e)) throw new Error('Not allowed');
  if (await tallyRunning()) return { ok: true, state: 'already-running' };
  let exe = findTallyExe();
  if (!exe) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Find TallyPrime (tally.exe) - asked only once',
      properties: ['openFile'], filters: [{ name: 'TallyPrime', extensions: ['exe'] }]
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, state: 'not-found' };
    exe = r.filePaths[0];
    writeCfg({ ...readCfg(), tallyPath: exe });
  }
  spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) }).unref();
  return { ok: true, state: 'started' };
});

/* ---------- main window ---------- */
const offlinePage = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<body style="font:16px system-ui;padding:48px;background:#14171d;color:#e8eaf0"><h2>Cannot reach the portal</h2>' +
  '<p>Check the internet connection. Trying again every few seconds…</p></body>');

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, show: false, autoHideMenuBar: true, title: 'Explore Learning',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // Entry guide = small always-on-top window, so TallyPrime can stay full screen beneath it.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName === 'portal_entry_guide') {
      const wa = screen.getPrimaryDisplay().workArea;
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 410, height: 430, x: wa.x + wa.width - 430, y: wa.y + wa.height - 450,
          title: 'Live entry guide', autoHideMenuBar: true, minimizable: false, alwaysOnTop: true
        }
      };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url); // Drive links etc. open in the normal browser
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => child.setAlwaysOnTop(true, 'screen-saver'));

  // Stay inside the portal; anything else opens in the normal browser.
  win.webContents.on('will-navigate', (ev, url) => {
    if (new URL(url).origin !== PORTAL_ORIGIN && !url.startsWith('data:')) { ev.preventDefault(); shell.openExternal(url); }
  });
  win.webContents.on('did-fail-load', (ev, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;
    win.loadURL(offlinePage);
    setTimeout(() => { if (win) win.loadURL(PORTAL_URL); }, 5000);
  });
  win.loadURL(PORTAL_URL);
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'notifications'));
  createWindow();
});
app.on('window-all-closed', () => app.quit());
