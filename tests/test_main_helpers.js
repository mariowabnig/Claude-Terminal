#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const mainPath = path.join(__dirname, '..', 'main.js');
const source = fs.readFileSync(mainPath, 'utf8');
const helperSource = source.slice(0, source.indexOf('// AI Agent Terminal View'));
const sandbox = {
    module: { exports: {} },
    require: (id) => id === 'obsidian' ? {} : require(id),
    console,
};

vm.runInNewContext(`${helperSource}\nmodule.exports = {
    getSessionStatus,
    splitShellArgs,
    parseNonNegativeInteger,
    buildSpawnPath,
};`, sandbox, { filename: mainPath });

const {
    getSessionStatus,
    splitShellArgs,
    parseNonNegativeInteger,
    buildSpawnPath,
} = sandbox.module.exports;

assert.deepStrictEqual(Array.from(splitShellArgs('--flag "value with spaces" plain')), [
    '--flag', 'value with spaces', 'plain',
]);
assert.strictEqual(parseNonNegativeInteger('0', 60), 0);
assert.strictEqual(parseNonNegativeInteger('-5', 60), 0);
assert.strictEqual(parseNonNegativeInteger('invalid', 60), 60);

assert.strictEqual(getSessionStatus({ process: {}, isWorking: true }), 'working');
assert.strictEqual(getSessionStatus({ process: {}, hasWorked: true }), 'paused');
assert.strictEqual(getSessionStatus({ process: {}, userInteracted: true }), 'active');
assert.strictEqual(getSessionStatus({ process: {}, exited: true }), 'done');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-terminal-path-'));
try {
    const existingPath = ['/usr/bin', tempDir].join(path.delimiter);
    assert.strictEqual(
        buildSpawnPath(existingPath, [tempDir, '/usr/bin']),
        [tempDir, '/usr/bin'].join(path.delimiter)
    );
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}

assert(source.includes('if (this.settings.autoOpen) {'));
assert(source.includes('this._openingFileKey = fileKey;'));
assert(source.includes('const { status, displayName } = sessionInfo;'));
assert(!source.includes('session.displayName || \'AI agent\';'));

console.log('AI Agent Terminal helper tests passed');
