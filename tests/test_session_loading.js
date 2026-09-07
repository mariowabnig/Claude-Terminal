const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sandbox = { require: id => id === 'obsidian' ? new Proxy({}, { get: () => class {} }) : require(id), module: { exports: {} }, setTimeout: () => 0, console };
vm.runInNewContext(fs.readFileSync(`${__dirname}/../main.js`, 'utf8') + '\nmodule.exports = ClaudeTerminalView;', sandbox);
const View = sandbox.module.exports;
(async () => {
  let created = 0, attached = 0;
  const view = { _xtermLoaded: false, currentFileKey: null, terminal: null, headerLabel: {}, plugin: { sessions: new Map(), settings: {}, _updateFileTreeBadges() {} }, _detachCurrentTerminal() {}, _attachTerminal() { attached++; }, async _createSession() { created++; return { process: {} }; } };
  await View.prototype.switchSession.call(view, 'a.tex', '/test/a.tex', {});
  assert.equal(created, 0);
  assert.equal(attached, 0);
  assert.equal(view.currentFileKey, null);
  view._xtermLoaded = true;
  await View.prototype.switchSession.call(view, 'a.tex', '/test/a.tex', {});
  assert.equal(created, 1);
  assert.equal(attached, 1);
  console.log('Terminal loading regressions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
