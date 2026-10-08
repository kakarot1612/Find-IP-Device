'use strict';

const net = require('node:net');

class TraceError extends Error {
  constructor(message, code = 'TRACE_FAILED', details = {}) {
    super(message);
    this.name = 'TraceError';
    this.code = code;
    this.details = details;
  }
}

function normalizeMac(value) {
  const compact = String(value || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  if (!/^[a-f0-9]{12}$/.test(compact)) return null;
  return compact;
}

function formatMac(value) {
  const compact = normalizeMac(value);
  if (!compact) return null;
  return `${compact.slice(0, 4)}.${compact.slice(4, 8)}.${compact.slice(8, 12)}`;
}

function macFromLine(line) {
  const candidates = String(line).match(
    /(?:[a-fA-F0-9]{4}[.:-]){2}[a-fA-F0-9]{4}|(?:[a-fA-F0-9]{2}[.:-]){5}[a-fA-F0-9]{2}/g,
  ) || [];
  return candidates.map(normalizeMac).find(Boolean) || null;
}

function parseArpOutput(output, targetIp) {
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.includes(targetIp)) continue;
    const mac = macFromLine(line);
    if (!mac) continue;
    const interfaceMatch = line.match(/\b(Vlan\s*\d+|Vl\s*\d+)\b/i);
    const vlanMatch = interfaceMatch?.[1].match(/\d+/);
    return {
      ip: targetIp,
      mac: formatMac(mac),
      vlan: vlanMatch ? Number(vlanMatch[0]) : null,
      interface: interfaceMatch ? interfaceMatch[1].replace(/\s+/g, '') : null,
      sourceLine: line.trim(),
    };
  }
  return null;
}

function parseMacTable(output, targetMac) {
  const wanted = normalizeMac(targetMac);
  if (!wanted) return null;

  for (const line of String(output).split(/\r?\n/)) {
    if (normalizeMac(macFromLine(line)) !== wanted) continue;
    const trimmed = line.trim();
    const tokens = trimmed.split(/\s+/);
    const port = [...tokens].reverse().find((token) =>
      /^(?:Po\d+|Port-channel\d+|[A-Za-z][A-Za-z-]*\d+(?:\/\d+){0,4}(?:\.\d+)?)$/i.test(token),
    );
    if (!port || /^(?:Vlan|Vl)\d+$/i.test(port)) continue;
    const vlanToken = tokens.find((token) => /^\d+$/.test(token));
    const type = tokens.find((token) => /^(?:DYNAMIC|STATIC|SECURE|SELF|SYSTEM)$/i.test(token));
    return {
      vlan: vlanToken ? Number(vlanToken) : null,
      mac: formatMac(wanted),
      type: type ? type.toUpperCase() : null,
      port,
      sourceLine: trimmed,
    };
  }
  return null;
}

function normalizePortChannel(value) {
  const match = String(value || '').trim().match(/^(?:Po|Port-channel)(\d+)$/i);
  return match ? `Po${match[1]}` : null;
}

function parseEtherchannelSummary(output, targetPortChannel) {
  const wanted = normalizePortChannel(targetPortChannel);
  if (!wanted) return null;

  const lines = String(output || '').split(/\r?\n/);
  let channel = null;
  const memberLines = [];

  for (const line of lines) {
    const groupMatch = line.match(/^\s*(\d+)\s+(Po\d+)\(([^)]+)\)\s+(\S+)(.*)$/i);
    if (groupMatch) {
      if (channel) break;
      if (normalizePortChannel(groupMatch[2]) !== wanted) continue;
      channel = {
        group: Number(groupMatch[1]),
        portChannel: wanted,
        status: groupMatch[3],
        protocol: groupMatch[4],
        members: [],
      };
      memberLines.push(groupMatch[5]);
      continue;
    }
    if (channel) memberLines.push(line);
  }

  if (!channel) return null;
  const memberText = memberLines.join(' ');
  for (const match of memberText.matchAll(/\b([A-Za-z][A-Za-z-]*\d+(?:\/\d+){1,4})\(([A-Za-z])\)/g)) {
    const state = match[2].toUpperCase();
    channel.members.push({ port: match[1], state, active: state === 'P' });
  }
  return channel;
}

function parseNeighbor(output, protocol = 'CDP') {
  const text = String(output || '');
  if (!text.trim() || /(?:invalid input|not found|no (?:cdp|lldp) neighbors?|total entries displayed\s*:\s*0)/i.test(text)) {
    return null;
  }

  const deviceId = text.match(/(?:Device ID|System Name)\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || null;
  const ipMatches = [...text.matchAll(
    /(?:IP(?:v4)? address|Management Address(?:es)?(?:\s*\(IPv4\))?)\s*:\s*(\d{1,3}(?:\.\d{1,3}){3})/gi,
  )];
  const ip = ipMatches.map((match) => match[1]).find((value) => net.isIP(value) === 4) || null;
  const platform = text.match(/Platform\s*:\s*([^,\r\n]+)/i)?.[1]?.trim()
    || text.match(/System Description\s*:\s*([^\r\n]+)/i)?.[1]?.trim()
    || null;
  const capabilities = text.match(/(?:Enabled Capabilities|Capabilities)\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || null;
  const remotePort = text.match(/(?:Port ID \(outgoing port\)|Port id)\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || null;
  const switchSignals = [deviceId, platform, capabilities, text].filter(Boolean).join(' ');
  const likelySwitch = /\b(?:switch|bridge|router|cisco|catalyst|nexus|c\d{3,4}|ws-c|ios[- ]?xe)\b/i.test(switchSignals)
    || /(?:Enabled Capabilities|Capabilities)\s*:\s*(?:.*\bB\b|.*\bS\b)/i.test(text);

  if (!deviceId && !ip && !platform) return null;
  return { protocol, deviceId, ip, platform, capabilities, remotePort, likelySwitch };
}

function parseSwitchport(output) {
  const text = String(output || '');
  const adminMode = text.match(/Administrative Mode\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || null;
  const operationalMode = text.match(/Operational Mode\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || null;
  const accessVlan = text.match(/Access Mode VLAN\s*:\s*(\d+)/i)?.[1] || null;
  const nativeVlan = text.match(/Trunking Native Mode VLAN\s*:\s*(\d+)/i)?.[1] || null;
  return {
    adminMode,
    operationalMode,
    accessVlan: accessVlan ? Number(accessVlan) : null,
    nativeVlan: nativeVlan ? Number(nativeVlan) : null,
  };
}

function parseInterfaceStatus(output, port) {
  const lines = String(output || '').split(/\r?\n/);
  const line = lines.find((candidate) => candidate.trim().toLowerCase().startsWith(String(port).toLowerCase()));
  if (!line) return { port, statusLine: null };
  const connected = /\bconnected\b/i.test(line) && !/\bnotconnect\b/i.test(line);
  return { port, connected, statusLine: line.trim() };
}

function hasCliError(output) {
  return /%(?: Invalid input| Ambiguous command| Incomplete command| Unknown command)/i.test(String(output));
}

async function runFirst(session, commands, parser, emit, hopNumber, host) {
  let last = null;
  for (const command of commands) {
    const output = await session.run(command);
    last = { command, output };
    emit({ type: 'command', hop: hopNumber, host, command, output });
    if (hasCliError(output)) continue;
    const parsed = parser(output);
    if (parsed) return { ...last, parsed };
  }
  return { ...last, parsed: null };
}

async function findNeighborOnPort(session, port, emit, hopNumber, host) {
  let result = await runFirst(
    session,
    [`show cdp neighbors ${port} detail`, `show cdp neighbors interface ${port} detail`],
    (output) => parseNeighbor(output, 'CDP'),
    emit,
    hopNumber,
    host,
  );
  if (!result.parsed) {
    result = await runFirst(
      session,
      [`show lldp neighbors ${port} detail`, `show lldp neighbors interface ${port} detail`],
      (output) => parseNeighbor(output, 'LLDP'),
      emit,
      hopNumber,
      host,
    );
  }
  return result;
}

function validateTraceRequest(input) {
  const cameraIp = String(input.cameraIp || '').trim();
  const coreHost = String(input.coreHost || '').trim();
  const username = String(input.username || process.env.CISCO_SSH_USERNAME || '').trim();
  const password = input.password || process.env.CISCO_SSH_PASSWORD || undefined;
  const privateKey = input.privateKey || process.env.CISCO_SSH_PRIVATE_KEY || undefined;
  const passphrase = input.passphrase || process.env.CISCO_SSH_KEY_PASSPHRASE || undefined;
  const enablePassword = input.enablePassword || process.env.CISCO_ENABLE_PASSWORD || undefined;
  if (net.isIP(cameraIp) !== 4) throw new TraceError('IP camera không hợp lệ.', 'INVALID_CAMERA_IP');
  if (!coreHost) throw new TraceError('Chưa nhập IP hoặc hostname của Core switch.', 'MISSING_CORE');
  if (!username) throw new TraceError('Chưa nạp tài khoản SSH. Hãy chạy setup-credentials.ps1.', 'MISSING_USERNAME');
  if (!password && !privateKey) {
    throw new TraceError('Chưa nạp mật khẩu hoặc private key SSH. Hãy chạy setup-credentials.ps1.', 'MISSING_AUTH');
  }
  return {
    cameraIp,
    coreHost,
    username,
    password,
    privateKey,
    passphrase,
    enablePassword,
    maxHops: Math.min(Math.max(Number(input.maxHops) || 8, 1), 20),
    timeoutMs: Math.min(Math.max(Number(input.timeoutMs) || 15000, 5000), 60000),
  };
}

async function traceCamera(input, dependencies) {
  const options = validateTraceRequest(input);
  const emit = dependencies.emit || (() => {});
  const createSession = dependencies.createSession;
  const visited = new Set();
  const hops = [];
  let currentHost = options.coreHost;
  let cameraMac = null;
  let arp = null;

  emit({ type: 'start', cameraIp: options.cameraIp, coreHost: options.coreHost });

  for (let hopNumber = 1; hopNumber <= options.maxHops; hopNumber += 1) {
    if (visited.has(currentHost.toLowerCase())) {
      throw new TraceError(`Phát hiện vòng lặp tại thiết bị ${currentHost}.`, 'LOOP_DETECTED', { hops });
    }
    visited.add(currentHost.toLowerCase());
    emit({ type: 'connecting', hop: hopNumber, host: currentHost });

    const session = await createSession({ ...options, host: currentHost });
    try {
      await session.connect();
      const prompt = session.prompt || currentHost;
      emit({ type: 'connected', hop: hopNumber, host: currentHost, prompt, legacySsh: session.legacyMode === true });

      if (!cameraMac) {
        const arpResult = await runFirst(
          session,
          [
            `show ip arp ${options.cameraIp}`,
            `show arp | include ${options.cameraIp}`,
            `show ip arp | include ${options.cameraIp}`,
          ],
          (output) => parseArpOutput(output, options.cameraIp),
          emit,
          hopNumber,
          currentHost,
        );
        arp = arpResult.parsed;
        if (!arp) {
          throw new TraceError(
            `Không tìm thấy ARP cho ${options.cameraIp} trên Core. Hãy ping camera từ gateway rồi thử lại.`,
            'ARP_NOT_FOUND',
          );
        }
        cameraMac = arp.mac;
        emit({ type: 'arp', hop: hopNumber, host: currentHost, arp });
      }

      const macResult = await runFirst(
        session,
        [
          `show mac address-table address ${cameraMac}`,
          `show mac-address-table address ${cameraMac}`,
          `show mac address-table | include ${cameraMac}`,
        ],
        (output) => parseMacTable(output, cameraMac),
        emit,
        hopNumber,
        currentHost,
      );
      const macEntry = macResult.parsed;
      if (!macEntry) {
        throw new TraceError(
          `Không tìm thấy MAC ${cameraMac} trên ${prompt}.`,
          'MAC_NOT_FOUND',
          { host: currentHost, cameraMac },
        );
      }

      const port = macEntry.port;
      const statusResult = await runFirst(
        session,
        [`show interfaces ${port} status`, `show interface ${port} status`],
        (output) => parseInterfaceStatus(output, port),
        emit,
        hopNumber,
        currentHost,
      );
      const descriptionResult = await runFirst(
        session,
        [`show interfaces ${port} description`, `show interface ${port} description`],
        (output) => ({ text: String(output).trim() }),
        emit,
        hopNumber,
        currentHost,
      );
      const switchportResult = await runFirst(
        session,
        [`show interfaces ${port} switchport`, `show interface ${port} switchport`],
        (output) => parseSwitchport(output),
        emit,
        hopNumber,
        currentHost,
      );

      const switchportMode = switchportResult.parsed?.operationalMode
        || switchportResult.parsed?.adminMode
        || '';
      const isAccessPort = /access/i.test(switchportMode) && !normalizePortChannel(port);
      if (isAccessPort) {
        const hop = {
          number: hopNumber,
          host: currentHost,
          device: prompt.replace(/[>#]\s*$/, '').trim(),
          macEntry,
          port,
          status: statusResult.parsed,
          description: descriptionResult.output?.trim() || null,
          switchport: switchportResult.parsed,
          neighbor: null,
          neighborPort: null,
          etherchannel: null,
          legacySsh: session.legacyMode === true,
        };
        hops.push(hop);
        emit({ type: 'hop', hop });
        const result = {
          cameraIp: options.cameraIp,
          cameraMac,
          vlan: arp.vlan || macEntry.vlan,
          coreHost: options.coreHost,
          finalDevice: hop.device,
          finalHost: hop.host,
          finalPort: port,
          hops,
          completedAt: new Date().toISOString(),
        };
        emit({ type: 'complete', result });
        return result;
      }

      let etherchannel = null;
      let neighborPorts = [port];
      const portChannel = normalizePortChannel(port);
      if (portChannel) {
        const etherchannelResult = await runFirst(
          session,
          ['show etherchannel summary', 'show port-channel summary'],
          (output) => parseEtherchannelSummary(output, portChannel),
          emit,
          hopNumber,
          currentHost,
        );
        etherchannel = etherchannelResult.parsed;
        const activeMembers = etherchannel?.members.filter((member) => member.active).map((member) => member.port) || [];
        if (!activeMembers.length) {
          throw new TraceError(
            `Không tìm thấy member forwarding (P) của ${portChannel} trong etherchannel summary.`,
            'PORT_CHANNEL_MEMBER_NOT_FOUND',
            { host: currentHost, portChannel, etherchannel },
          );
        }
        neighborPorts = activeMembers;
      }

      let neighborResult = { parsed: null };
      let neighborPort = null;
      for (const discoveryPort of neighborPorts) {
        neighborResult = await findNeighborOnPort(session, discoveryPort, emit, hopNumber, currentHost);
        if (neighborResult.parsed) {
          neighborPort = discoveryPort;
          break;
        }
      }

      const neighbor = neighborResult.parsed;
      const hop = {
        number: hopNumber,
        host: currentHost,
        device: prompt.replace(/[>#]\s*$/, '').trim(),
        macEntry,
        port,
        status: statusResult.parsed,
        description: descriptionResult.output?.trim() || null,
        switchport: switchportResult.parsed,
        neighbor,
        neighborPort,
        etherchannel,
        legacySsh: session.legacyMode === true,
      };
      hops.push(hop);
      emit({ type: 'hop', hop });

      if (!neighbor || !neighbor.likelySwitch) {
        const mode = switchportResult.parsed?.operationalMode || '';
        const looksLikeUplink = /trunk|routed/i.test(mode) || /^(?:Po\d+|Port-channel\d+)$/i.test(port);
        if (looksLikeUplink) {
          throw new TraceError(
            `MAC đang nằm trên uplink ${port} (${mode || 'port-channel'}) nhưng không tìm thấy switch kế tiếp qua CDP/LLDP.`,
            'UPLINK_NEIGHBOR_NOT_FOUND',
            { hops, host: currentHost, port, mode, memberPorts: neighborPorts },
          );
        }
        const result = {
          cameraIp: options.cameraIp,
          cameraMac,
          vlan: arp.vlan || macEntry.vlan,
          coreHost: options.coreHost,
          finalDevice: hop.device,
          finalHost: hop.host,
          finalPort: port,
          hops,
          completedAt: new Date().toISOString(),
        };
        emit({ type: 'complete', result });
        return result;
      }

      if (!neighbor.ip) {
        throw new TraceError(
          `Đã thấy switch kế tiếp ${neighbor.deviceId || ''} trên ${port}, nhưng CDP/LLDP không có IP quản trị.`,
          'NEIGHBOR_IP_MISSING',
          { hops, neighbor },
        );
      }
      currentHost = neighbor.ip;
    } finally {
      session.close();
    }
  }

  throw new TraceError(`Đã đạt giới hạn ${options.maxHops} hop nhưng chưa tới port camera.`, 'MAX_HOPS', { hops });
}

module.exports = {
  TraceError,
  formatMac,
  normalizeMac,
  parseArpOutput,
  parseEtherchannelSummary,
  parseInterfaceStatus,
  parseMacTable,
  parseNeighbor,
  parseSwitchport,
  runFirst,
  traceCamera,
  validateTraceRequest,
};
