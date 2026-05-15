/*
 * AI Agent Terminal — Obsidian Plugin
 * Right-sidebar AI coding terminal that follows the currently viewed file.
 * Persistent sessions per file, status badges in the file tree.
 */

const { Plugin, PluginSettingTab, Setting, Notice, ItemView, FuzzySuggestModal } = require('obsidian');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const VIEW_TYPE = 'claude-terminal-view';

// PTY bridge is loaded from pty-bridge.py at runtime (see _createSession)

function getSessionStatus(session) {
    const proc = session.process;
    if (!proc || proc.killed || session.exited) return 'done';
    if (session.isWorking) return 'working';
    if (session.userInteracted) return 'active';
    if (session.hasWorked) return 'paused';
    return 'idle';
}

// File extensions we support (basically: text files you'd want an AI agent to work on)
const SUPPORTED_EXTENSIONS = new Set([
    'tex', 'md', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'html',
    'py', 'rb', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp',
    'json', 'yaml', 'yml', 'toml', 'xml', 'svg',
    'sh', 'bash', 'zsh', 'fish',
    'lua', 'vim', 'el', 'clj', 'sql',
    'txt', 'csv', 'ini', 'conf', 'cfg',
]);

function isSupportedFile(file) {
    if (!file) return false;
    return SUPPORTED_EXTENSIONS.has(file.extension);
}

function expandHome(filePath, homeDir) {
    if (!filePath) return '';
    return filePath.startsWith('~/') ? path.join(homeDir, filePath.slice(2)) : filePath;
}

function splitShellArgs(input) {
    const args = [];
    let current = '';
    let quote = null;
    let escaped = false;

    for (const ch of input || '') {
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (ch === quote) {
                quote = null;
            } else {
                current += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (current) {
                args.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }

    if (escaped) current += '\\';
    if (current) args.push(current);
    return args;
}

function getBackendSettings(settings) {
    const backend = ['claude', 'codex', 'custom'].includes(settings.cliBackend)
        ? settings.cliBackend
        : 'claude';
    const customName = (settings.customDisplayName || '').trim();
    const displayName = backend === 'claude' ? 'Claude Code'
        : backend === 'codex' ? 'Codex'
        : customName || 'Custom CLI';
    return { backend, displayName };
}

function getBuiltinPrompt(fileKey, file, agentName) {
    const fileName = path.basename(fileKey);
    const ext = file?.extension || '';
    const classMatch = fileName.match(/-(\d\w)\./i);
    const className = classMatch ? classMatch[1].toUpperCase() : '';

    if (ext === 'tex') {
        return `We are working on ${JSON.stringify(fileKey)}${className ? ` for class ${className}` : ''}. Read the AI-Router at _School-Hub/_ai-instructions/AI-Router.md first, then fix the following issues. After fixing, run the post-worksheet-chain (compile, deploy, visual-verify, update Serienplan). Here is what needs to be fixed: `;
    }

    return `We are working on the file ${JSON.stringify(fileKey)}. Read it first, then help me with the following: `;
}

function renderPromptTemplate(template, context) {
    return (template || '').replace(/\{(filePath|fileName|className|agentName)\}/g, (_, key) => context[key] || '');
}

function getInitialPrompt(settings, fileKey, file, agentName) {
    const builtinPrompt = getBuiltinPrompt(fileKey, file, agentName);
    if (getBackendSettings(settings).backend !== 'custom') return builtinPrompt;

    const fileName = path.basename(fileKey);
    const classMatch = fileName.match(/-(\d\w)\./i);
    const template = file?.extension === 'tex'
        ? settings.customTexPromptTemplate
        : settings.customPromptTemplate;
    if (!template || !template.trim()) return builtinPrompt;

    return renderPromptTemplate(template, {
        filePath: fileKey,
        fileName,
        className: classMatch ? classMatch[1].toUpperCase() : '',
        agentName,
    });
}

function getNvmCodexCandidates(homeDir, env) {
    const candidates = [];
    const nvmDirs = [
        env.NVM_DIR,
        path.join(homeDir, '.nvm'),
    ].filter(Boolean);

    for (const nvmDir of [...new Set(nvmDirs)]) {
        const versionsDir = path.join(nvmDir, 'versions', 'node');
        try {
            if (!fs.existsSync(versionsDir)) continue;
            const versions = fs.readdirSync(versionsDir)
                .filter(v => fs.existsSync(path.join(versionsDir, v, 'bin', 'codex')))
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            for (const version of versions) {
                candidates.push(path.join(versionsDir, version, 'bin', 'codex'));
            }
        } catch(e) {}
    }

    return candidates;
}

function resolveBackendCommand(settings, homeDir, env) {
    const { backend, displayName } = getBackendSettings(settings);
    let configuredPath = '';
    let candidates = [];
    let fixedArgs = [];

    if (backend === 'claude') {
        configuredPath = expandHome(settings.claudeBinaryPath, homeDir);
        candidates = configuredPath ? [configuredPath] : [
            path.join(homeDir, '.local/bin/claude'),
            '/opt/homebrew/bin/claude',
            '/usr/local/bin/claude',
        ];
        fixedArgs = settings.skipPermissions ? ['--dangerously-skip-permissions'] : [];
    } else if (backend === 'codex') {
        configuredPath = expandHome(settings.codexBinaryPath, homeDir);
        candidates = configuredPath ? [configuredPath] : [
            path.join(homeDir, '.local/bin/codex'),
            '/opt/homebrew/bin/codex',
            '/usr/local/bin/codex',
            ...getNvmCodexCandidates(homeDir, env),
        ];
        fixedArgs = ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'];
    } else {
        configuredPath = expandHome(settings.customBinaryPath, homeDir);
        candidates = [configuredPath].filter(Boolean);
        fixedArgs = splitShellArgs(settings.customFixedArgs || '');
    }

    const binaryPath = candidates.find(p => p && fs.existsSync(p)) || '';
    return { backend, displayName, binaryPath, fixedArgs, configuredPath };
}

// ---------------------------------------------------------------------------
// AI Agent Terminal View — right sidebar with xterm.js terminal
// ---------------------------------------------------------------------------
class ClaudeTerminalView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.terminal = null;
        this.fitAddon = null;
        this.currentFileKey = null;
        this.headerLabel = null;
        this.statusDot = null;
        this.terminalEl = null;
        this.resizeObserver = null;
    }

    getViewType() { return VIEW_TYPE; }
    getDisplayText() { return 'AI Agent Terminal'; }
    getIcon() { return 'terminal'; }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('claude-term-container');

        // Header bar showing current file
        const header = contentEl.createDiv({ cls: 'claude-term-header' });
        this.statusDot = header.createEl('span', {
            cls: 'claude-term-status-dot idle',
            attr: { title: 'Idle — waiting for input' }
        });
        this.headerLabel = header.createEl('span', {
            cls: 'claude-term-header-label',
            text: 'No file selected'
        });

        // Terminal container
        this.terminalEl = contentEl.createDiv({ cls: 'claude-term-terminal' });

        // Load xterm.js dynamically from the plugin folder
        await this._loadXterm();

        // If there's a currently active file, switch to it
        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (activeFile && isSupportedFile(activeFile)) {
            const key = activeFile.path;
            const absPath = path.join(this.plugin.app.vault.adapter.basePath, key);
            await this.switchSession(key, absPath, activeFile);
        }
    }

    async _loadXterm() {
        if (this._xtermLoaded) return;

        const pluginDir = this.plugin.manifest.dir;
        const basePath = this.app.vault.adapter.basePath;

        if (!pluginDir || !basePath) {
            console.error('AI Agent Terminal: cannot resolve plugin path');
            return;
        }

        const pluginPath = path.join(basePath, pluginDir);

        // Inject xterm CSS
        const xtermCssPath = path.join(pluginPath, 'xterm.css');
        if (fs.existsSync(xtermCssPath)) {
            const cssText = fs.readFileSync(xtermCssPath, 'utf-8');
            if (!document.getElementById('claude-term-xterm-css')) {
                const style = document.createElement('style');
                style.id = 'claude-term-xterm-css';
                style.textContent = cssText;
                document.head.appendChild(style);
            }
        }

        const xtermPath = path.join(pluginPath, 'xterm.js');
        const fitPath = path.join(pluginPath, 'addon-fit.js');

        try {
            const nodeRequire = window.require;
            if (nodeRequire && nodeRequire.cache) {
                delete nodeRequire.cache[nodeRequire.resolve(xtermPath)];
                delete nodeRequire.cache[nodeRequire.resolve(fitPath)];
            }
            this._xtermModule = nodeRequire(xtermPath);
            this._fitModule = nodeRequire(fitPath);
        } catch (e1) {
            try {
                const xtermCode = fs.readFileSync(xtermPath, 'utf-8');
                const fitCode = fs.readFileSync(fitPath, 'utf-8');
                const loadUMD = (code) => {
                    const fakeModule = { exports: {} };
                    const fn = new Function('module', 'exports', 'require', 'globalThis', code);
                    fn(fakeModule, fakeModule.exports, require, globalThis);
                    return fakeModule.exports;
                };
                this._xtermModule = loadUMD(xtermCode);
                this._fitModule = loadUMD(fitCode);
            } catch (e2) {
                console.error('AI Agent Terminal: all xterm loading approaches failed', e2);
                return;
            }
        }

        this._xtermLoaded = true;
    }

    /**
     * Switch to a session for the given file key (vault-relative path).
     * Creates a new session if one doesn't exist.
     */
    async switchSession(fileKey, absPath, file) {
        if (fileKey === this.currentFileKey && this.terminal) {
            return; // already showing
        }

        // Start auto-close timer on the session we're leaving
        const leavingSession = this.currentFileKey ? this.plugin.sessions.get(this.currentFileKey) : null;
        const timeout = (this.plugin.settings.idleSessionTimeout || 0) * 1000;
        if (leavingSession && !leavingSession.userInteracted && !leavingSession.exited && timeout > 0) {
            leavingSession._autoCloseTimer = setTimeout(() => {
                this.plugin._autoCloseSession(leavingSession);
            }, timeout);
        }

        this._detachCurrentTerminal();
        this.currentFileKey = fileKey;

        // Update header
        const displayName = path.basename(fileKey);
        const dirName = path.dirname(fileKey);
        const shortDir = dirName.split('/').slice(-2).join('/');
        this.headerLabel.textContent = shortDir ? `${displayName} (${shortDir})` : displayName;

        // Check for existing session
        let session = this.plugin.sessions.get(fileKey);

        if (session && session.process) {
            // Reattach existing session (live or dead) — cancel auto-close
            clearTimeout(session._autoCloseTimer);
            this._attachTerminal(session);
            this._updateStatusDot(session);
        } else {
            session = await this._createSession(fileKey, absPath, file);
            if (session) {
                this.plugin.sessions.set(fileKey, session);
                this._attachTerminal(session);
                this.plugin._updateFileTreeBadges();
                setTimeout(() => this.plugin._updateFileTreeBadges(), 500);
            }
        }
    }

    _detachCurrentTerminal() {
        if (this.terminal) {
            // Note: don't dispose — session.terminal is reused on reattach
            if (this.terminalEl) {
                while (this.terminalEl.firstChild) {
                    this.terminalEl.removeChild(this.terminalEl.firstChild);
                }
            }
            this.terminal = null;
            this.fitAddon = null;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
    }

    _attachTerminal(session) {
        if (!this._xtermLoaded || !this.terminalEl) return;

        if (session.terminal && session.terminalEl) {
            // Reattach existing terminal
            this.terminalEl.appendChild(session.terminalEl);
            this.terminal = session.terminal;
            this.fitAddon = session.fitAddon;

            setTimeout(() => {
                if (this.fitAddon) {
                    try { this.fitAddon.fit(); } catch(e) {}
                }
            }, 50);
        } else {
            // Create new terminal UI
            const termDiv = document.createElement('div');
            termDiv.className = 'claude-term-xterm-wrapper';
            this.terminalEl.appendChild(termDiv);

            const XTerm = this._xtermModule.Terminal;
            const FitAddon = this._fitModule.FitAddon;

            const cs = getComputedStyle(document.body);
            const settings = this.plugin.settings;
            const terminal = new XTerm({
                cursorBlink: true,
                fontSize: settings.terminalFontSize || 13,
                fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                theme: {
                    background: cs.getPropertyValue('--background-primary').trim() || '#1e1e1e',
                    foreground: cs.getPropertyValue('--text-normal').trim() || '#d4d4d4',
                    cursor: cs.getPropertyValue('--interactive-accent').trim() || '#528bff',
                },
                scrollback: settings.terminalScrollback || 10000,
                convertEol: true,
            });

            const fitAddon = new FitAddon();
            terminal.loadAddon(fitAddon);
            terminal.open(termDiv);

            setTimeout(() => {
                try { fitAddon.fit(); } catch(e) {}
            }, 50);

            this.terminal = terminal;
            this.fitAddon = fitAddon;

            session.terminal = terminal;
            session.terminalEl = termDiv;
            session.fitAddon = fitAddon;

            // Wire terminal input to PTY
            terminal.onData((data) => {
                if (session.process && !session.process.killed) {
                    session.userInteracted = true;
                    clearTimeout(session._autoCloseTimer);
                    try { session.process.stdin.write(data); } catch(e) {}
                }
            });

            // stdout/stderr listeners are registered once in _createSession,
            // writing to session.terminal (which always points to the current terminal).
        }

        // ResizeObserver to auto-fit terminal
        this.resizeObserver = new ResizeObserver(() => {
            if (this.fitAddon) {
                try {
                    this.fitAddon.fit();
                    if (session.resizePipe && this.terminal) {
                        const dims = this.fitAddon.proposeDimensions();
                        if (dims) {
                            try {
                                session.resizePipe.write(`${dims.cols},${dims.rows}\n`);
                            } catch(e) {}
                        }
                    }
                } catch(e) {}
            }
        });
        this.resizeObserver.observe(this.terminalEl);
    }

    _updateStatusDot(session) {
        if (!this.statusDot) return;
        if (session.key !== this.currentFileKey) return;

        const status = getSessionStatus(session);
        const titles = { done: 'Session finished', working: 'Working...', paused: 'Waiting for input', active: 'Active', idle: 'No activity yet' };
        this.statusDot.className = `claude-term-status-dot ${status}`;
        this.statusDot.title = titles[status] || '';
    }

    async _createSession(fileKey, absPath, file) {
        const settings = this.plugin.settings;
        const homeDir = require('os').homedir();

        // Build env before backend resolution so Codex nvm detection can use NVM_DIR.
        const spawnEnv = { ...globalThis.process.env, TERM: 'xterm-256color', PYTHONIOENCODING: 'utf-8' };
        delete spawnEnv.CLAUDECODE;

        const command = resolveBackendCommand(settings, homeDir, spawnEnv);
        const { backend, displayName: cliName, binaryPath: cliBinaryPath } = command;
        if (!cliBinaryPath) {
            const configured = command.configuredPath ? ` at ${command.configuredPath}` : '';
            new Notice(`${cliName} binary not found${configured}. Check AI Agent Terminal settings.`);
            return null;
        }

        // Resolve Python3 path
        let pythonPath = settings.pythonPath || null;
        if (!pythonPath) {
            for (const p of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
                if (fs.existsSync(p)) { pythonPath = p; break; }
            }
        }
        if (!pythonPath) {
            new Notice('Python3 not found — needed for terminal PTY. Set path in plugin settings.');
            return null;
        }

        // Load PTY bridge script from plugin folder
        const pluginDir = this.plugin.manifest.dir;
        const basePath = this.plugin.app.vault.adapter.basePath;
        const ptyBridgePath = path.join(basePath, pluginDir, 'pty-bridge.py');
        if (!fs.existsSync(ptyBridgePath)) {
            new Notice('pty-bridge.py not found in plugin folder.');
            return null;
        }

        const extraPaths = [
            path.join(homeDir, 'Library/TinyTeX/bin/universal-darwin'),
            path.join(homeDir, '.local/bin'),
            '/opt/homebrew/bin',
            '/opt/homebrew/sbin',
            '/usr/local/bin',
            '/Library/TeX/texbin',
        ];
        // If using a detected binary from nvm or a custom location, ensure its bin dir is on PATH.
        if (cliBinaryPath) {
            const cliBinDir = path.dirname(cliBinaryPath);
            if (!extraPaths.includes(cliBinDir)) {
                extraPaths.unshift(cliBinDir);
            }
        }
        if (settings.extraPathDirs) {
            for (const d of settings.extraPathDirs.split(',').map(s => s.trim()).filter(Boolean)) {
                extraPaths.push(d);
            }
        }
        const currentPath = spawnEnv.PATH || '';
        const missingPaths = extraPaths.filter(p => !currentPath.includes(p) && fs.existsSync(p));
        if (missingPaths.length > 0) {
            spawnEnv.PATH = missingPaths.join(':') + ':' + currentPath;
        }

        const vaultRoot = this.plugin.app.vault.adapter.basePath;
        const cliArgs = [cliBinaryPath, ...command.fixedArgs];

        const proc = spawn(pythonPath, [
            ptyBridgePath, ...cliArgs
        ], {
            cwd: vaultRoot,
            env: spawnEnv,
            stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        });

        const session = {
            key: fileKey,
            absPath,
            file,
            backend,
            displayName: cliName,
            process: proc,
            resizePipe: proc.stdio[3],
            terminal: null,
            terminalEl: null,
            fitAddon: null,
            initialPromptSent: false,
            userInteracted: false,  // true once the user types anything
            _autoCloseTimer: null,  // 60s timer to kill unused sessions
        };

        proc.on('error', (err) => {
            console.error('AI Agent Terminal: process error', err);
            new Notice(`${cliName} process error: ${err.message}`);
            session.exited = true;
        });

        // Wire PTY output to terminal — registered once, safe across reattach
        proc.stdout.on('data', (data) => {
            if (session.terminal) session.terminal.write(data);
            session.lastActivity = Date.now();
            session.hasWorked = true;
            if (!session.isWorking) {
                session.isWorking = true;
                this._updateStatusDot(session);
                this.plugin._updateFileTreeBadges();
            }
            clearTimeout(session._idleTimer);
            session._idleTimer = setTimeout(() => {
                session.isWorking = false;
                this._updateStatusDot(session);
                this.plugin._updateFileTreeBadges();
            }, 3000);
        });
        proc.stderr.on('data', (data) => {
            if (session.terminal) session.terminal.write(data);
            session.lastActivity = Date.now();
        });

        proc.on('exit', (code) => {
            if (session.terminal) {
                session.terminal.write(`\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m\r\n`);
            }
            session.isWorking = false;
            session.exited = true;
            clearTimeout(session._idleTimer);
            this._updateStatusDot(session);
            if (this.plugin.settings.notifyOnSessionDone) {
                const status = code === 0 ? 'completed' : `exited (code ${code})`;
                new Notice(`${cliName} session ${status}: ${path.basename(fileKey)}`, 5000);
            }
            this.plugin._updateFileTreeBadges();
        });

        const initialPrompt = getInitialPrompt(settings, fileKey, file, cliName);

        // Wait for the selected CLI to be ready, then send initial prompt.
        let outputBuf = '';
        const sendInitialPrompt = () => {
            if (session.initialPromptSent || !proc || proc.killed) return;
            session.initialPromptSent = true;
            try {
                proc.stdin.write(initialPrompt);
            } catch(e) {}
            // Auto-focus terminal after initial prompt so cursor is ready
            setTimeout(() => {
                if (session.terminal) session.terminal.focus();
            }, 100);
        };

        const readyListener = (data) => {
            outputBuf += data.toString();
            if (outputBuf.includes('>') || outputBuf.includes('\u276f') || outputBuf.includes('Claude') || outputBuf.includes('Codex') || outputBuf.includes('codex') || outputBuf.includes(cliName)) {
                proc.stdout.removeListener('data', readyListener);
                setTimeout(sendInitialPrompt, 500);
            }
        };
        proc.stdout.on('data', readyListener);

        // Fallback: send after 10 seconds
        setTimeout(() => {
            proc.stdout.removeListener('data', readyListener);
            sendInitialPrompt();
        }, 10000);

        return session;
    }

    async onClose() {
        this._detachCurrentTerminal();
        // Don't kill sessions — they persist for reattachment
    }
}

// ---------------------------------------------------------------------------
// Default settings
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
    autoOpen: true,               // auto-open sidebar when viewing a supported file
    // --- CLI backend ---
    cliBackend: 'claude',          // 'claude', 'codex', or 'custom'
    // --- Claude process ---
    claudeBinaryPath: '',          // '' = auto-detect (~/.local/bin/claude)
    codexBinaryPath: '',           // '' = auto-detect common locations including nvm
    customDisplayName: 'Custom CLI',
    customBinaryPath: '',
    customFixedArgs: '',
    customPromptTemplate: '',
    customTexPromptTemplate: '',
    pythonPath: '',                 // '' = auto-detect (searches common locations)
    extraPathDirs: '',              // comma-separated extra PATH dirs (appended to built-in list)
    skipPermissions: false,          // pass --dangerously-skip-permissions to Claude (⚠️ security risk)
    // --- Terminal appearance ---
    terminalFontSize: 13,          // xterm font size
    terminalScrollback: 10000,     // xterm scrollback lines
    // --- Session behavior ---
    idleSessionTimeout: 60,        // seconds before unused sessions are auto-closed (0 = never)
    // --- Notifications ---
    notifyOnSessionDone: true,     // notify when an agent session exits
};

// ---------------------------------------------------------------------------
// Main Plugin
// ---------------------------------------------------------------------------
class ClaudeTerminalPlugin extends Plugin {
    constructor() {
        super(...arguments);
        this.sessions = new Map();       // fileKey -> session object
        this._currentFileKey = null;     // currently tracked file
    }

    async onload() {
        await this.loadSettings();

        // --- Inject styles ---
        if (!document.getElementById('claude-term-styles')) {
            const style = document.createElement('style');
            style.id = 'claude-term-styles';
            style.textContent = `
                /* Container */
                .claude-term-container {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    overflow: hidden;
                }

                /* Header */
                .claude-term-header {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    padding: 6px 8px;
                    font-size: 12px;
                    font-weight: 600;
                    border-bottom: 1px solid var(--background-modifier-border);
                    background: var(--background-secondary);
                    flex-shrink: 0;
                }
                .claude-term-header-label {
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--text-normal);
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                /* Status dot */
                .claude-term-status-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    flex-shrink: 0;
                    transition: background-color 0.3s ease;
                }
                .claude-term-status-dot.idle {
                    background-color: var(--text-muted, #888);
                }
                .claude-term-status-dot.working {
                    background-color: var(--text-warning, #e6a700);
                    animation: claude-term-dot-pulse 1.5s ease-in-out infinite;
                }
                .claude-term-status-dot.paused,
                .claude-term-status-dot.active {
                    background-color: var(--text-warning, #e6a700);
                }
                .claude-term-status-dot.done {
                    background-color: var(--text-success, #4caf50);
                }
                @keyframes claude-term-dot-pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.4; }
                }

                /* Terminal area */
                .claude-term-terminal {
                    flex: 1;
                    overflow: hidden;
                    position: relative;
                }
                .claude-term-xterm-wrapper {
                    width: 100%;
                    height: 100%;
                }
                .claude-term-xterm-wrapper .xterm {
                    height: 100%;
                }
                .claude-term-xterm-wrapper .xterm-viewport {
                    overflow-y: auto !important;
                }

                /* File tree badges */
                .oz-nav-file-title .claude-term-badge,
                .nav-file-title .claude-term-badge {
                    display: inline-flex;
                    align-items: center;
                    margin-left: 4px;
                    font-size: 10px;
                    line-height: 1;
                    vertical-align: middle;
                }
                .claude-term-badge.is-working {
                    color: var(--text-warning, #e6a700);
                    animation: claude-term-badge-pulse 1.5s ease-in-out infinite;
                }
                .claude-term-badge.is-idle {
                    color: var(--text-muted, #888);
                }
                .claude-term-badge.is-done {
                    color: var(--text-success, #4caf50);
                }
                @keyframes claude-term-badge-pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }
            `;
            document.head.appendChild(style);
        }

        // --- File tree badge observer ---
        this._badgeDebounce = null;
        this._fileTreeObserver = new MutationObserver(() => {
            if (this.sessions.size === 0) return;
            clearTimeout(this._badgeDebounce);
            this._badgeDebounce = setTimeout(() => this._updateFileTreeBadges(), 150);
        });

        this.app.workspace.onLayoutReady(() => {
            const targets = document.querySelectorAll(
                '.oz-file-tree-files, .oz-file-list-pane, .nav-files-container'
            );
            for (const t of targets) {
                this._fileTreeObserver.observe(t, { childList: true, subtree: true });
            }
            this.registerEvent(
                this.app.workspace.on('layout-change', () => {
                    const newTargets = document.querySelectorAll(
                        '.oz-file-tree-files, .oz-file-list-pane, .nav-files-container'
                    );
                    for (const t of newTargets) {
                        this._fileTreeObserver.observe(t, { childList: true, subtree: true });
                    }
                    this._updateFileTreeBadges();
                })
            );
        });

        // --- Register the sidebar view ---
        this.registerView(
            VIEW_TYPE,
            (leaf) => new ClaudeTerminalView(leaf, this)
        );

        // Sync xterm theme when Obsidian theme changes (light/dark switch)
        this.registerEvent(
            this.app.workspace.on('css-change', () => {
                const cs = getComputedStyle(document.body);
                const theme = {
                    background: cs.getPropertyValue('--background-primary').trim() || '#1e1e1e',
                    foreground: cs.getPropertyValue('--text-normal').trim() || '#d4d4d4',
                    cursor: cs.getPropertyValue('--interactive-accent').trim() || '#528bff',
                };
                for (const session of this.sessions.values()) {
                    if (session.terminal) {
                        session.terminal.options.theme = theme;
                    }
                }
            })
        );

        // --- Track active file and switch sessions ---
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                if (!leaf) return;
                const file = leaf.view?.file;
                if (!file || !isSupportedFile(file)) return;
                this._onFileFocused(file);
            })
        );

        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (!file || !isSupportedFile(file)) return;
                this._onFileFocused(file);
            })
        );

        // --- Commands ---
        const activeBackendName = getBackendSettings(this.settings).displayName;
        this.addCommand({
            id: 'toggle-claude-terminal',
            name: `Toggle AI Agent Terminal sidebar (${activeBackendName})`,
            hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'L' }],
            callback: () => this.toggleTerminal(),
        });

        this.addCommand({
            id: 'open-claude-for-file',
            name: `Open AI Agent Terminal for current file (${activeBackendName})`,
            callback: () => {
                const file = this.app.workspace.getActiveFile();
                if (file && isSupportedFile(file)) {
                    this._openTerminalForFile(file);
                } else {
                    new Notice('No supported file is currently active.');
                }
            },
        });

        this.addCommand({
            id: 'list-sessions',
            name: `Show active AI Agent Terminal sessions (${activeBackendName})`,
            callback: () => {
                if (this.sessions.size === 0) {
                    new Notice('No active AI Agent Terminal sessions.');
                    return;
                }
                new SessionPickerModal(this.app, this).open();
            },
        });

        // --- Settings ---
        this.addSettingTab(new ClaudeTerminalSettingTab(this.app, this));

        console.log('AI Agent Terminal loaded');
    }

    onunload() {
        try {
            document.getElementById('claude-term-styles')?.remove();
            document.getElementById('claude-term-xterm-css')?.remove();
            clearTimeout(this._badgeDebounce);
            this._fileTreeObserver?.disconnect();
            document.querySelectorAll('.claude-term-badge').forEach(el => el.remove());
        } catch (e) {
            console.warn('AI Agent Terminal: cleanup error (styles/observer)', e);
        }

        // Kill all sessions — each wrapped individually to prevent cascading failures
        for (const session of this.sessions.values()) {
            try {
                if (session.process && !session.process.killed) {
                    session.process.kill('SIGTERM');
                }
            } catch (e) {
                console.warn('AI Agent Terminal: failed to kill process', e);
            }
            try {
                if (session.terminal) {
                    session.terminal.dispose();
                }
            } catch (e) {
                console.warn('AI Agent Terminal: failed to dispose terminal', e);
            }
        }
        this.sessions.clear();

        // Close view
        try {
            this.app.workspace.detachLeavesOfType(VIEW_TYPE);
        } catch (e) {
            console.warn('AI Agent Terminal: failed to detach view', e);
        }

        console.log('AI Agent Terminal unloaded');
    }

    // -----------------------------------------------------------------------
    // File focus handling
    // -----------------------------------------------------------------------

    _onFileFocused(file) {
        const fileKey = file.path;

        if (fileKey === this._currentFileKey) return;
        this._currentFileKey = fileKey;

        // Only auto-switch if the sidebar is already open (or autoOpen is enabled)
        const termLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (termLeaves.length === 0 && !this.settings.autoOpen) return;
        if (termLeaves.length > 0) {
            const view = termLeaves[0].view;
            if (view instanceof ClaudeTerminalView) {
                const absPath = path.join(this.app.vault.adapter.basePath, fileKey);
                view.switchSession(fileKey, absPath, file);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Toggle / open terminal
    // -----------------------------------------------------------------------

    async toggleTerminal() {
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (existing.length > 0) {
            // Already open — just focus the terminal
            const view = existing[0].view;
            this.app.workspace.revealLeaf(existing[0]);
            if (view instanceof ClaudeTerminalView && view.terminal) {
                setTimeout(() => view.terminal.focus(), 50);
            }
            return;
        }

        const file = this.app.workspace.getActiveFile();
        if (file && isSupportedFile(file)) {
            await this._openTerminalForFile(file);
        } else {
            // Open sidebar with no session
            const rightLeaf = this.app.workspace.getRightLeaf(false);
            await rightLeaf.setViewState({
                type: VIEW_TYPE,
                active: true,
            });
            this.app.workspace.revealLeaf(rightLeaf);
            // Auto-focus terminal if a session is already attached
            const view = rightLeaf.view;
            if (view instanceof ClaudeTerminalView && view.terminal) {
                setTimeout(() => view.terminal.focus(), 100);
            }
        }
    }

    async _openTerminalForFile(file) {
        const fileKey = file.path;
        const absPath = path.join(this.app.vault.adapter.basePath, fileKey);

        // Ensure sidebar exists
        let termLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (termLeaves.length === 0) {
            const rightLeaf = this.app.workspace.getRightLeaf(false);
            await rightLeaf.setViewState({
                type: VIEW_TYPE,
                active: true,
            });
            termLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        }

        if (termLeaves.length === 0) return;

        const view = termLeaves[0].view;
        if (view instanceof ClaudeTerminalView) {
            await view.switchSession(fileKey, absPath, file);
            this.app.workspace.revealLeaf(termLeaves[0]);
            // Auto-focus the terminal so the user can type immediately
            setTimeout(() => {
                if (view.terminal) view.terminal.focus();
            }, 100);
        }
    }

    // -----------------------------------------------------------------------
    // Auto-close unused sessions (no user interaction after 60s)
    // -----------------------------------------------------------------------

    _autoCloseSession(session) {
        if (session.userInteracted || session.exited) return;
        console.log(`AI Agent Terminal: auto-closing unused session for "${session.key}"`);

        // Kill the process
        if (session.process && !session.process.killed) {
            session.process.kill('SIGTERM');
        }
        // Dispose terminal
        if (session.terminal) {
            session.terminal.dispose();
        }
        // Remove from sessions map
        this.sessions.delete(session.key);
        this._updateFileTreeBadges();
    }

    _closeAllSessions() {
        for (const session of this.sessions.values()) {
            clearTimeout(session._autoCloseTimer);
            clearTimeout(session._idleTimer);
            try {
                if (session.process && !session.process.killed) {
                    session.process.kill('SIGTERM');
                }
            } catch(e) {}
            try {
                if (session.terminal) {
                    session.terminal.dispose();
                }
            } catch(e) {}
        }
        this.sessions.clear();
        this._updateFileTreeBadges();
    }

    async _restartOpenTerminalForActiveFile() {
        const termLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
        if (termLeaves.length === 0) return;

        const view = termLeaves[0].view;
        if (!(view instanceof ClaudeTerminalView)) return;

        view._detachCurrentTerminal();
        view.currentFileKey = null;
        const file = this.app.workspace.getActiveFile();
        if (file && isSupportedFile(file)) {
            await this._openTerminalForFile(file);
        } else if (view.headerLabel) {
            view.headerLabel.textContent = 'No file selected';
        }
    }

    // -----------------------------------------------------------------------
    // File tree badges
    // -----------------------------------------------------------------------

    _getSessionFilePaths() {
        const map = new Map();
        for (const [fileKey, session] of this.sessions) {
            map.set(fileKey, getSessionStatus(session));
        }
        return map;
    }

    _updateFileTreeBadges() {
        // Remove existing badges
        document.querySelectorAll('.claude-term-badge').forEach(el => el.remove());

        if (this.sessions.size === 0) return;

        const sessionFiles = this._getSessionFilePaths();
        if (sessionFiles.size === 0) return;

        const allEntries = document.querySelectorAll(
            '.oz-nav-file-title[data-path], .nav-file-title[data-path]'
        );

        for (const entry of allEntries) {
            const dataPath = entry.getAttribute('data-path');
            if (!dataPath) continue;

            const status = sessionFiles.get(dataPath);
            if (!status) continue;

            if (entry.querySelector('.claude-term-badge')) continue;

            const badge = document.createElement('span');
            const badgeCls = status === 'working' ? 'is-working'
                           : status === 'idle' ? 'is-idle'
                           : 'is-done';
            badge.className = `claude-term-badge ${badgeCls}`;
            badge.textContent = status === 'done' ? '\u2713' : '\u25cf';
            const agentName = session.displayName || 'AI agent';
            badge.title = status === 'working' ? `${agentName} is working...`
                        : status === 'idle' ? `${agentName} session idle`
                        : `${agentName} session finished`;

            const extTag = entry.querySelector('.oz-nav-file-tag, .nav-file-tag');
            if (extTag) {
                entry.insertBefore(badge, extTag);
            } else {
                entry.appendChild(badge);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// ---------------------------------------------------------------------------
// Session Picker Modal
// ---------------------------------------------------------------------------
class SessionPickerModal extends FuzzySuggestModal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        const backendName = getBackendSettings(plugin.settings).displayName;
        this.setPlaceholder(`Switch to a ${backendName} session...`);
    }

    getItems() {
        const items = [];
        for (const [fileKey, session] of this.plugin.sessions) {
            items.push({ fileKey, session, status: getSessionStatus(session) });
        }
        const order = { working: 0, active: 1, paused: 1, idle: 2, done: 3 };
        items.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
        return items;
    }

    getItemText(item) {
        const icon = item.status === 'working' ? '\u25cf Working'
                   : item.status === 'active' ? '\u25cf Active'
                   : item.status === 'idle' ? '\u25cb Idle'
                   : '\u2713 Done';
        return `${path.basename(item.fileKey)}  [${icon}]  ${item.fileKey}`;
    }

    onChooseItem(item) {
        const file = this.plugin.app.vault.getAbstractFileByPath(item.fileKey);
        if (!file) {
            new Notice(`File not found: ${item.fileKey}`);
            return;
        }

        // Check if the file is already open in a main-area leaf
        let targetLeaf = null;
        this.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (!targetLeaf
                && leaf.view?.file?.path === item.fileKey
                && leaf.getRoot() === this.plugin.app.workspace.rootSplit) {
                targetLeaf = leaf;
            }
        });

        if (targetLeaf) {
            // Already open — just focus it
            this.plugin.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
        } else {
            // Open in the most recent main-area leaf
            const mainLeaf = this.plugin.app.workspace.getMostRecentLeaf(
                this.plugin.app.workspace.rootSplit
            );
            (mainLeaf || this.plugin.app.workspace.getLeaf(false)).openFile(file);
        }
    }
}

// ---------------------------------------------------------------------------
// Settings Tab
// ---------------------------------------------------------------------------
class ClaudeTerminalSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'AI Agent Terminal' });

        const desc = containerEl.createEl('p');
        desc.style.color = 'var(--text-muted)';
        desc.style.fontSize = '13px';
        desc.style.marginBottom = '16px';
        desc.textContent = 'Right-sidebar AI coding terminal that follows the currently viewed file. ' +
            'Each file gets its own persistent terminal session. Toggle with Ctrl+Shift+L.';

        new Setting(containerEl)
            .setName('Auto-open for supported files')
            .setDesc('Automatically open the AI Agent Terminal sidebar when viewing a supported file type.')
            .addToggle(toggle =>
                toggle.setValue(this.plugin.settings.autoOpen)
                    .onChange(async (val) => {
                        this.plugin.settings.autoOpen = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Notify on session exit')
            .setDesc('Show a notification when an AI agent session process exits.')
            .addToggle(toggle =>
                toggle.setValue(this.plugin.settings.notifyOnSessionDone)
                    .onChange(async (val) => {
                        this.plugin.settings.notifyOnSessionDone = val;
                        await this.plugin.saveSettings();
                    })
            );

        // --- CLI backend ---
        containerEl.createEl('h3', { text: 'CLI backend' });

        new Setting(containerEl)
            .setName('CLI backend')
            .setDesc('Choose which AI coding CLI to use for terminal sessions.')
            .addDropdown(dropdown => dropdown
                .addOption('claude', 'Claude Code')
                .addOption('codex', 'Codex')
                .addOption('custom', this.plugin.settings.customDisplayName || 'Custom CLI')
                .setValue(this.plugin.settings.cliBackend)
                .onChange(async (value) => {
                    const oldBackend = getBackendSettings(this.plugin.settings).backend;
                    this.plugin.settings.cliBackend = value;
                    await this.plugin.saveSettings();
                    if (value !== oldBackend) {
                        const hadSessions = this.plugin.sessions.size > 0;
                        this.plugin._closeAllSessions();
                        await this.plugin._restartOpenTerminalForActiveFile();
                        if (hadSessions) {
                            const backendName = getBackendSettings(this.plugin.settings).displayName;
                            new Notice(`Switched to ${backendName}. Existing sessions were closed so new terminals use the selected backend.`);
                        }
                    }
                    this.display(); // re-render to show/hide backend-specific settings
                })
            );

        const { backend } = getBackendSettings(this.plugin.settings);
        const isClaude = backend === 'claude';
        const isCodex = backend === 'codex';
        const isCustom = backend === 'custom';

        if (isClaude) {
            new Setting(containerEl)
                .setName('Claude binary path')
                .setDesc('Path to the Claude Code binary. Leave empty to auto-detect common locations.')
                .addText(text => text
                    .setPlaceholder('~/.local/bin/claude')
                    .setValue(this.plugin.settings.claudeBinaryPath)
                    .onChange(async (value) => {
                        this.plugin.settings.claudeBinaryPath = value.trim();
                        await this.plugin.saveSettings();
                    })
                );
        }

        if (isCodex) {
            new Setting(containerEl)
                .setName('Codex binary path')
                .setDesc('Path to the Codex binary. Leave empty to auto-detect ~/.local/bin, Homebrew, /usr/local/bin, and nvm installs.')
                .addText(text => text
                    .setPlaceholder('auto-detect')
                    .setValue(this.plugin.settings.codexBinaryPath)
                    .onChange(async (value) => {
                        this.plugin.settings.codexBinaryPath = value.trim();
                        await this.plugin.saveSettings();
                    })
                );
        }

        if (isCustom) {
            new Setting(containerEl)
                .setName('Custom display name')
                .setDesc('Name shown in notices, badges, and session labels for the Custom CLI backend.')
                .addText(text => text
                    .setPlaceholder('Custom CLI')
                    .setValue(this.plugin.settings.customDisplayName)
                    .onChange(async (value) => {
                        this.plugin.settings.customDisplayName = value.trim() || 'Custom CLI';
                        await this.plugin.saveSettings();
                    })
                );

            new Setting(containerEl)
                .setName('Custom binary path')
                .setDesc('Full path to the custom agent CLI binary.')
                .addText(text => text
                    .setPlaceholder('/path/to/agent')
                    .setValue(this.plugin.settings.customBinaryPath)
                    .onChange(async (value) => {
                        this.plugin.settings.customBinaryPath = value.trim();
                        await this.plugin.saveSettings();
                    })
                );

            new Setting(containerEl)
                .setName('Custom fixed arguments')
                .setDesc('Arguments passed before the prompt. Supports normal shell-like quotes for paths and values with spaces.')
                .addText(text => text
                    .setPlaceholder('--flag \"value with spaces\"')
                    .setValue(this.plugin.settings.customFixedArgs)
                    .onChange(async (value) => {
                        this.plugin.settings.customFixedArgs = value;
                        await this.plugin.saveSettings();
                    })
                );

            new Setting(containerEl)
                .setName('Use current prompts for Custom CLI')
                .setDesc('Copy the built-in generic and .tex prompt wording into the editable Custom CLI templates.')
                .addButton(button => button
                    .setButtonText('Copy prompts')
                    .onClick(async () => {
                        this.plugin.settings.customPromptTemplate = 'We are working on the file "{filePath}". Read it first, then help me with the following: ';
                        this.plugin.settings.customTexPromptTemplate = 'We are working on "{filePath}". Read the AI-Router at _School-Hub/_ai-instructions/AI-Router.md first, then fix the following issues. After fixing, run the post-worksheet-chain (compile, deploy, visual-verify, update Serienplan). Here is what needs to be fixed: ';
                        await this.plugin.saveSettings();
                        new Notice('Copied current prompts into Custom CLI templates.');
                        this.display();
                    })
                );

            new Setting(containerEl)
                .setName('Custom generic prompt template')
                .setDesc('Used for non-.tex files. Supports {filePath}, {fileName}, {className}, and {agentName}. Empty uses the built-in prompt.')
                .addTextArea(text => text
                    .setPlaceholder('We are working on the file \"{filePath}\"...')
                    .setValue(this.plugin.settings.customPromptTemplate)
                    .onChange(async (value) => {
                        this.plugin.settings.customPromptTemplate = value;
                        await this.plugin.saveSettings();
                    })
                );

            new Setting(containerEl)
                .setName('Custom .tex prompt template')
                .setDesc('Used for .tex files. Supports {filePath}, {fileName}, {className}, and {agentName}. Empty uses the built-in prompt.')
                .addTextArea(text => text
                    .setPlaceholder('We are working on \"{filePath}\"...')
                    .setValue(this.plugin.settings.customTexPromptTemplate)
                    .onChange(async (value) => {
                        this.plugin.settings.customTexPromptTemplate = value;
                        await this.plugin.saveSettings();
                    })
                );
        }

        new Setting(containerEl)
            .setName('Python3 path')
            .setDesc('Path to Python 3 binary. Leave empty to auto-detect.')
            .addText(text => text
                .setPlaceholder('auto-detect')
                .setValue(this.plugin.settings.pythonPath)
                .onChange(async (value) => {
                    this.plugin.settings.pythonPath = value.trim();
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Extra PATH directories')
            .setDesc('Comma-separated extra directories to add to PATH when spawning the CLI.')
            .addText(text => text
                .setPlaceholder('/path/one, /path/two')
                .setValue(this.plugin.settings.extraPathDirs)
                .onChange(async (value) => {
                    this.plugin.settings.extraPathDirs = value;
                    await this.plugin.saveSettings();
                })
            );

        if (isClaude) {
            new Setting(containerEl)
                .setName('Skip permission prompts')
                .setDesc('Pass --dangerously-skip-permissions to Claude Code.')
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.skipPermissions)
                    .onChange(async (value) => {
                        this.plugin.settings.skipPermissions = value;
                        await this.plugin.saveSettings();
                    })
                );
        }

        // --- Terminal appearance ---
        containerEl.createEl('h3', { text: 'Terminal appearance' });

        new Setting(containerEl)
            .setName('Terminal font size')
            .setDesc('Font size for the xterm terminal (default: 13).')
            .addText(text => text
                .setPlaceholder('13')
                .setValue(String(this.plugin.settings.terminalFontSize))
                .onChange(async (value) => {
                    this.plugin.settings.terminalFontSize = Math.max(8, parseInt(value) || 13);
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Terminal scrollback lines')
            .setDesc('Number of lines to keep in terminal scrollback buffer (default: 10000).')
            .addText(text => text
                .setPlaceholder('10000')
                .setValue(String(this.plugin.settings.terminalScrollback))
                .onChange(async (value) => {
                    this.plugin.settings.terminalScrollback = Math.max(100, parseInt(value) || 10000);
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Idle session timeout (seconds)')
            .setDesc('Seconds before an unused session is auto-closed when you switch away. 0 = never.')
            .addText(text => text
                .setPlaceholder('60')
                .setValue(String(this.plugin.settings.idleSessionTimeout))
                .onChange(async (value) => {
                    this.plugin.settings.idleSessionTimeout = Math.max(0, parseInt(value) || 60);
                    await this.plugin.saveSettings();
                })
            );
    }
}

module.exports = ClaudeTerminalPlugin;
