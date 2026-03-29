/*
 * Claude Terminal — Obsidian Plugin
 * Right-sidebar Claude Code terminal that follows the currently viewed file.
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

// Python PTY bridge script — spawns a shell command inside a real PTY
// so Claude Code gets full TTY support (colors, interactive mode, etc.)
const PTY_BRIDGE_SCRIPT = `
import sys, os, select, struct, fcntl, termios, pty, signal

def main():
    cmd = sys.argv[1:]
    if not cmd:
        sys.exit(1)

    # Create a PTY pair
    master_fd, slave_fd = pty.openpty()

    # Spawn the child process in the slave PTY
    pid = os.fork()
    if pid == 0:
        # Child process
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        os.close(master_fd)
        os.close(slave_fd)
        os.execvp(cmd[0], cmd)

    # Parent process
    os.close(slave_fd)

    def handle_resize(cols, rows):
        try:
            s = struct.pack('HHHH', rows, cols, 0, 0)
            fcntl.ioctl(master_fd, termios.TIOCSWINSZ, s)
            os.kill(pid, signal.SIGWINCH)
        except:
            pass

    import threading

    def read_stdin():
        while True:
            try:
                data = os.read(0, 4096)
                if not data:
                    break
                os.write(master_fd, data)
            except OSError:
                break

    stdin_thread = threading.Thread(target=read_stdin, daemon=True)
    stdin_thread.start()

    # Read fd 3 (resize channel) if available
    resize_fd = None
    try:
        resize_fd = 3
        os.fstat(resize_fd)
        def read_resize():
            buf = b''
            while True:
                try:
                    data = os.read(resize_fd, 1024)
                    if not data:
                        break
                    buf += data
                    while b'\\n' in buf:
                        line, buf = buf.split(b'\\n', 1)
                        parts = line.decode().strip().split(',')
                        if len(parts) == 2:
                            handle_resize(int(parts[0]), int(parts[1]))
                except OSError:
                    break
        resize_thread = threading.Thread(target=read_resize, daemon=True)
        resize_thread.start()
    except:
        pass

    # Read master and write to stdout
    while True:
        try:
            data = os.read(master_fd, 4096)
            if not data:
                break
            os.write(1, data)
            sys.stdout.flush()
        except OSError:
            break

    # Wait for child
    try:
        _, status = os.waitpid(pid, 0)
    except:
        pass

if __name__ == '__main__':
    main()
`;

function getSessionStatus(session) {
    const proc = session.process;
    if (!proc || proc.killed || session.exited) return 'done';
    if (session.isWorking) return 'working';
    if (session.userInteracted) return 'active';
    if (session.hasWorked) return 'paused';
    return 'idle';
}

// File extensions we support (basically: text files you'd want Claude to work on)
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

// ---------------------------------------------------------------------------
// Claude Terminal View — right sidebar with xterm.js terminal
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
    getDisplayText() { return 'Claude Terminal'; }
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
            console.error('Claude Terminal: cannot resolve plugin path');
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
                console.error('Claude Terminal: all xterm loading approaches failed', e2);
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
        if (leavingSession && !leavingSession.userInteracted && !leavingSession.exited) {
            leavingSession._autoCloseTimer = setTimeout(() => {
                this.plugin._autoCloseSession(leavingSession);
            }, 60000);
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
            const terminal = new XTerm({
                cursorBlink: true,
                fontSize: 13,
                fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                theme: {
                    background: cs.getPropertyValue('--background-primary').trim() || '#1e1e1e',
                    foreground: cs.getPropertyValue('--text-normal').trim() || '#d4d4d4',
                    cursor: cs.getPropertyValue('--interactive-accent').trim() || '#528bff',
                },
                scrollback: 10000,
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

            // Wire PTY output to terminal
            if (session.process && session.process.stdout) {
                session.process.stdout.on('data', (data) => {
                    if (session.terminal) {
                        session.terminal.write(data);
                    }
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
                session.process.stderr.on('data', (data) => {
                    if (session.terminal) {
                        session.terminal.write(data);
                    }
                    session.lastActivity = Date.now();
                });
            }
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
        const homeDir = require('os').homedir();
        const claudePath = path.join(homeDir, '.local/bin/claude');
        if (!fs.existsSync(claudePath)) {
            new Notice('Claude Code not found at ~/.local/bin/claude');
            return null;
        }

        // Find Python3
        const pythonCandidates = [
            '/opt/homebrew/bin/python3',
            '/usr/local/bin/python3',
            '/usr/bin/python3',
        ];
        let pythonPath = null;
        for (const p of pythonCandidates) {
            if (fs.existsSync(p)) { pythonPath = p; break; }
        }
        if (!pythonPath) {
            new Notice('Python3 not found — needed for terminal PTY');
            return null;
        }

        // Build env
        const spawnEnv = { ...globalThis.process.env, TERM: 'xterm-256color', PYTHONIOENCODING: 'utf-8' };
        delete spawnEnv.CLAUDECODE;

        const extraPaths = [
            path.join(homeDir, 'Library/TinyTeX/bin/universal-darwin'),
            path.join(homeDir, '.local/bin'),
            '/opt/homebrew/bin',
            '/opt/homebrew/sbin',
            '/usr/local/bin',
            '/Library/TeX/texbin',
        ];
        const currentPath = spawnEnv.PATH || '';
        const missingPaths = extraPaths.filter(p => !currentPath.includes(p) && fs.existsSync(p));
        if (missingPaths.length > 0) {
            spawnEnv.PATH = missingPaths.join(':') + ':' + currentPath;
        }

        const vaultRoot = this.plugin.app.vault.adapter.basePath;

        const proc = spawn(pythonPath, [
            '-c', PTY_BRIDGE_SCRIPT,
            claudePath, '--dangerously-skip-permissions'
        ], {
            cwd: vaultRoot,
            env: spawnEnv,
            stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        });

        const session = {
            key: fileKey,
            absPath,
            file,
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
            console.error('Claude Terminal: process error', err);
            new Notice(`Claude process error: ${err.message}`);
        });

        proc.on('exit', (code) => {
            console.log(`Claude Terminal: process exited with code ${code}`);
            if (session.terminal) {
                session.terminal.write(`\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m\r\n`);
            }
            session.isWorking = false;
            session.exited = true;
            clearTimeout(session._idleTimer);
            this._updateStatusDot(session);
            if (this.plugin.settings.notifyOnSessionDone) {
                const status = code === 0 ? 'completed' : `exited (code ${code})`;
                new Notice(`Claude session ${status}: ${path.basename(fileKey)}`, 5000);
            }
            this.plugin._updateFileTreeBadges();
        });

        // Build context-aware initial prompt based on file type
        const fileName = path.basename(fileKey);
        const ext = file?.extension || '';
        let initialPrompt;

        if (ext === 'tex') {
            const classMatch = fileName.match(/-(\d\w)\./i);
            const className = classMatch ? classMatch[1].toUpperCase() : '';
            initialPrompt = `We are working on "${fileKey}"${className ? ` for class ${className}` : ''}. Read the AI-Router at _School-Hub/_ai-instructions/AI-Router.md first, then fix the following issues. After fixing, run the post-worksheet-chain (compile, deploy, visual-verify, update Serienplan). Here is what needs to be fixed: `;
        } else {
            initialPrompt = `We are working on the file "${fileKey}". Read it first, then help me with the following: `;
        }

        // Wait for Claude to be ready, then send initial prompt
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
            if (outputBuf.includes('>') || outputBuf.includes('\u276f') || outputBuf.includes('Claude')) {
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
    notifyOnSessionDone: true,    // notify when Claude session exits
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
                .claude-term-status-dot.paused {
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
        this.addCommand({
            id: 'toggle-claude-terminal',
            name: 'Toggle Claude Terminal sidebar',
            hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'L' }],
            callback: () => this.toggleTerminal(),
        });

        this.addCommand({
            id: 'open-claude-for-file',
            name: 'Open Claude Terminal for current file',
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
            name: 'Show active Claude sessions',
            callback: () => {
                if (this.sessions.size === 0) {
                    new Notice('No active Claude sessions.');
                    return;
                }
                new SessionPickerModal(this.app, this).open();
            },
        });

        // --- Settings ---
        this.addSettingTab(new ClaudeTerminalSettingTab(this.app, this));

        console.log('Claude Terminal loaded');
    }

    onunload() {
        document.getElementById('claude-term-styles')?.remove();
        document.getElementById('claude-term-xterm-css')?.remove();
        clearTimeout(this._badgeDebounce);
        this._fileTreeObserver?.disconnect();
        document.querySelectorAll('.claude-term-badge').forEach(el => el.remove());

        // Kill all sessions
        for (const session of this.sessions.values()) {
            if (session.process && !session.process.killed) {
                session.process.kill('SIGTERM');
            }
            if (session.terminal) {
                session.terminal.dispose();
            }
        }
        this.sessions.clear();

        // Close view
        this.app.workspace.detachLeavesOfType(VIEW_TYPE);

        console.log('Claude Terminal unloaded');
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
        console.log(`Claude Terminal: auto-closing unused session for "${session.key}"`);

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
            badge.title = status === 'working' ? 'Claude is working...'
                        : status === 'idle' ? 'Claude session idle'
                        : 'Claude session finished';

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
        this.setPlaceholder('Switch to a Claude session...');
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
        containerEl.createEl('h2', { text: 'Claude Terminal' });

        const desc = containerEl.createEl('p');
        desc.style.color = 'var(--text-muted)';
        desc.style.fontSize = '13px';
        desc.style.marginBottom = '16px';
        desc.textContent = 'Right-sidebar Claude Code terminal that follows the currently viewed file. ' +
            'Each file gets its own persistent terminal session. Toggle with Ctrl+Shift+L.';

        new Setting(containerEl)
            .setName('Auto-open for supported files')
            .setDesc('Automatically open the Claude Terminal sidebar when viewing a supported file type.')
            .addToggle(toggle =>
                toggle.setValue(this.plugin.settings.autoOpen)
                    .onChange(async (val) => {
                        this.plugin.settings.autoOpen = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Notify on session exit')
            .setDesc('Show a notification when a Claude Code session process exits.')
            .addToggle(toggle =>
                toggle.setValue(this.plugin.settings.notifyOnSessionDone)
                    .onChange(async (val) => {
                        this.plugin.settings.notifyOnSessionDone = val;
                        await this.plugin.saveSettings();
                    })
            );
    }
}

module.exports = ClaudeTerminalPlugin;
