'use strict';

const { Client } = require('ssh2');

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const LEGACY_ALGORITHMS = {
  kex: {
    append: [
      'diffie-hellman-group-exchange-sha1',
      'diffie-hellman-group14-sha1',
      'diffie-hellman-group1-sha1',
    ],
  },
  serverHostKey: { append: ['ssh-dss'] },
  cipher: { append: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'] },
  hmac: { append: ['hmac-sha1-96', 'hmac-md5', 'hmac-md5-96'] },
};

function cleanTerminalText(value) {
  let text = String(value).replace(ANSI_PATTERN, '').replace(/\r/g, '');
  while (/[^\n]\x08/.test(text)) text = text.replace(/[^\n]\x08/g, '');
  return text.replace(/\x00/g, '');
}

class CiscoSshSession {
  constructor(options) {
    this.options = options;
    this.client = null;
    this.stream = null;
    this.buffer = '';
    this.waiter = null;
    this.prompt = null;
    this.closed = false;
    this.legacyMode = false;
  }

  async connect() {
    try {
      await this.connectTransport(false);
    } catch (error) {
      if (!/no matching .*algorithm/i.test(error.message || '')) throw error;
      this.client?.end();
      this.legacyMode = true;
      await this.connectTransport(true);
    }

    await this.openShell();
    return this;
  }

  async connectTransport(useLegacyAlgorithms) {
    this.client = new Client();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SSH timeout tới ${this.options.host}`)), this.options.timeoutMs);
      const finish = (callback) => (value) => {
        clearTimeout(timer);
        callback(value);
      };

      this.client
        .on('ready', finish(resolve))
        .on('error', finish(reject))
        .on('keyboard-interactive', (_name, _instructions, _language, prompts, done) => {
          done(prompts.map(() => this.options.password || ''));
        })
        .connect({
          host: this.options.host,
          port: 22,
          username: this.options.username,
          password: this.options.password,
          privateKey: this.options.privateKey,
          passphrase: this.options.passphrase,
          readyTimeout: this.options.timeoutMs,
          tryKeyboard: Boolean(this.options.password),
          keepaliveInterval: 10000,
          keepaliveCountMax: 2,
          algorithms: useLegacyAlgorithms ? LEGACY_ALGORITHMS : undefined,
        });
    });
  }

  async openShell() {
    await new Promise((resolve, reject) => {
      this.client.shell({ term: 'xterm', cols: 220, rows: 1000 }, (error, stream) => {
        if (error) return reject(error);
        this.stream = stream;
        stream.on('data', (chunk) => this.handleData(chunk));
        stream.stderr?.on('data', (chunk) => this.handleData(chunk));
        stream.on('close', () => this.rejectWaiter(new Error('SSH shell đã đóng.')));
        resolve();
      });
    });

    const initial = await this.waitFor((text) => this.findPrompt(text), this.options.timeoutMs);
    this.prompt = this.findPrompt(initial);

    if (this.prompt?.endsWith('>') && this.options.enablePassword) {
      this.buffer = '';
      this.stream.write('enable\n');
      const enableResponse = await this.waitFor(
        (text) => (/password\s*:/i.test(text) ? 'password' : this.findPrompt(text)),
        this.options.timeoutMs,
      );
      if (enableResponse === 'password') {
        this.buffer = '';
        this.stream.write(`${this.options.enablePassword}\n`);
        const enabled = await this.waitFor((text) => this.findPrompt(text), this.options.timeoutMs);
        this.prompt = this.findPrompt(enabled);
      }
    }

    await this.run('terminal length 0');
    await this.run('terminal width 220');
  }

  findPrompt(text) {
    const match = cleanTerminalText(text).match(/(?:^|\n)([^\n]+[>#])\s*$/);
    return match?.[1]?.trim() || null;
  }

  handleData(chunk) {
    let text = cleanTerminalText(chunk.toString('utf8'));
    if (/--More--|<--- More --->/i.test(text)) {
      text = text.replace(/--More--|<--- More --->/gi, '');
      this.stream?.write(' ');
    }
    this.buffer += text;
    if (this.waiter) {
      const result = this.waiter.predicate(this.buffer);
      if (result) {
        const { resolve, timer } = this.waiter;
        clearTimeout(timer);
        this.waiter = null;
        resolve(result === true ? this.buffer : result);
      }
    }
  }

  waitFor(predicate, timeoutMs) {
    if (this.waiter) return Promise.reject(new Error('Một lệnh SSH khác đang chạy.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`Thiết bị ${this.options.host} không trả về prompt trong thời gian cho phép.`));
      }, timeoutMs);
      this.waiter = { predicate, resolve, reject, timer };
      const immediate = predicate(this.buffer);
      if (immediate) {
        clearTimeout(timer);
        this.waiter = null;
        resolve(immediate === true ? this.buffer : immediate);
      }
    });
  }

  rejectWaiter(error) {
    if (!this.waiter) return;
    clearTimeout(this.waiter.timer);
    this.waiter.reject(error);
    this.waiter = null;
  }

  async run(command) {
    if (!this.stream || this.closed) throw new Error('SSH session chưa sẵn sàng.');
    this.buffer = '';
    this.stream.write(`${command}\n`);
    await this.waitFor((text) => this.findPrompt(text), this.options.timeoutMs);
    this.prompt = this.findPrompt(this.buffer) || this.prompt;
    return this.stripCommandOutput(this.buffer, command);
  }

  stripCommandOutput(raw, command) {
    const lines = cleanTerminalText(raw).split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    if (lines[0]?.trim().endsWith(command)) lines.shift();
    if (lines.length && /[>#]\s*$/.test(lines.at(-1))) lines.pop();
    return lines.join('\n').trim();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.rejectWaiter(new Error('SSH session đã đóng.'));
    this.stream?.end('exit\n');
    this.client?.end();
  }
}

module.exports = { CiscoSshSession, LEGACY_ALGORITHMS, cleanTerminalText };
