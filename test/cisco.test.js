'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatMac,
  parseArpOutput,
  parseEtherchannelSummary,
  parseMacTable,
  parseNeighbor,
  parseSwitchport,
  traceCamera,
  validateTraceRequest,
} = require('../src/cisco');
const { LEGACY_ALGORITHMS } = require('../src/ssh');

test('formatMac chuẩn hóa các định dạng MAC phổ biến', () => {
  assert.equal(formatMac('58:1c:f8:7b:47:c9'), '581c.f87b.47c9');
  assert.equal(formatMac('581c-f87b-47c9'), '581c.f87b.47c9');
  assert.equal(formatMac('invalid'), null);
});

test('SSH legacy fallback có KEX Cisco đời cũ', () => {
  assert.ok(LEGACY_ALGORITHMS.kex.append.includes('diffie-hellman-group14-sha1'));
  assert.ok(LEGACY_ALGORITHMS.kex.append.includes('diffie-hellman-group1-sha1'));
});

test('credential môi trường được dùng khi UI không gửi tài khoản', () => {
  const previousUsername = process.env.CISCO_SSH_USERNAME;
  const previousPassword = process.env.CISCO_SSH_PASSWORD;
  process.env.CISCO_SSH_USERNAME = 'shared-network-user';
  process.env.CISCO_SSH_PASSWORD = 'encrypted-at-rest';
  try {
    const options = validateTraceRequest({ cameraIp: '10.0.63.125', coreHost: '10.0.16.3' });
    assert.equal(options.username, 'shared-network-user');
    assert.equal(options.password, 'encrypted-at-rest');
  } finally {
    if (previousUsername === undefined) delete process.env.CISCO_SSH_USERNAME;
    else process.env.CISCO_SSH_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.CISCO_SSH_PASSWORD;
    else process.env.CISCO_SSH_PASSWORD = previousPassword;
  }
});

test('parseArpOutput lấy MAC và VLAN từ IOS ARP', () => {
  const output = `Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  10.0.63.125            2   581c.f87b.47c9  ARPA   Vlan63`;
  assert.deepEqual(parseArpOutput(output, '10.0.63.125'), {
    ip: '10.0.63.125',
    mac: '581c.f87b.47c9',
    vlan: 63,
    interface: 'Vlan63',
    sourceLine: 'Internet  10.0.63.125            2   581c.f87b.47c9  ARPA   Vlan63',
  });
});

test('parseMacTable lấy port uplink', () => {
  const output = `Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
  63    581c.f87b.47c9    DYNAMIC     Te1/1/1`;
  assert.equal(parseMacTable(output, '58:1c:f8:7b:47:c9').port, 'Te1/1/1');
});

test('parseEtherchannelSummary lấy member forwarding của Port-channel99', () => {
  const output = `Group  Port-channel  Protocol    Ports
------+-------------+-----------+-----------------------------------------------
98     Po98(SU)        LACP      Gi1/1/1(P) Gi2/1/1(P)
99     Po99(SU)         -        Te1/3/1(P)  Te2/3/1(P)
100    Po100(SU)        -        Te1/3/7(P)  Te1/3/8(P)`;
  assert.deepEqual(parseEtherchannelSummary(output, 'Port-channel99'), {
    group: 99,
    portChannel: 'Po99',
    status: 'SU',
    protocol: '-',
    members: [
      { port: 'Te1/3/1', state: 'P', active: true },
      { port: 'Te2/3/1', state: 'P', active: true },
    ],
  });
});

test('parseNeighbor đọc CDP neighbor switch', () => {
  const output = `Device ID: SW-CAM-07
Entry address(es):
  IP address: 10.0.254.107
Platform: cisco C9300-48P,  Capabilities: Router Switch IGMP
Interface: TenGigabitEthernet1/1/1,  Port ID (outgoing port): GigabitEthernet1/0/48`;
  const neighbor = parseNeighbor(output, 'CDP');
  assert.equal(neighbor.deviceId, 'SW-CAM-07');
  assert.equal(neighbor.ip, '10.0.254.107');
  assert.equal(neighbor.remotePort, 'GigabitEthernet1/0/48');
  assert.equal(neighbor.likelySwitch, true);
});

test('parseSwitchport đọc mode và VLAN access', () => {
  const output = `Administrative Mode: static access
Operational Mode: static access
Access Mode VLAN: 63 (CAMERA)
Trunking Native Mode VLAN: 1 (default)`;
  assert.deepEqual(parseSwitchport(output), {
    adminMode: 'static access', operationalMode: 'static access', accessVlan: 63, nativeVlan: 1,
  });
});

test('traceCamera đi qua switch downstream và trả về access port', async () => {
  const sessionOptions = [];
  const executedCommands = [];
  const outputs = {
    core: {
      'show ip arp 10.0.63.125': 'Internet  10.0.63.125  2  581c.f87b.47c9  ARPA  Vlan63',
      'show mac address-table address 581c.f87b.47c9': '63  581c.f87b.47c9  DYNAMIC  Po99',
      'show interfaces Po99 status': 'Po99 UPLINK connected trunk full 20G',
      'show interfaces Po99 description': 'Po99 up up SW-CAM-07',
      'show interfaces Po99 switchport': 'Operational Mode: trunk',
      'show etherchannel summary': '99 Po99(SU) - Te1/3/1(P) Te2/3/1(P)',
      'show cdp neighbors Te1/3/1 detail': 'Total cdp entries displayed : 0',
      'show cdp neighbors Te2/3/1 detail': 'Device ID: SW-CAM-07\nIP address: 10.0.254.107\nPlatform: cisco C9300, Capabilities: Switch\nPort ID (outgoing port): Gi1/0/48',
    },
    '10.0.254.107': {
      'show mac address-table address 581c.f87b.47c9': '63  581c.f87b.47c9  DYNAMIC  Gi1/0/18',
      'show interfaces Gi1/0/18 status': 'Gi1/0/18 CAMERA connected 63 full 1G',
      'show interfaces Gi1/0/18 description': 'Gi1/0/18 up up CAM-PARKING-01',
      'show interfaces Gi1/0/18 switchport': 'Operational Mode: static access\nAccess Mode VLAN: 63',
      'show cdp neighbors interface Gi1/0/18 detail': 'Total cdp entries displayed : 0',
      'show cdp neighbors Gi1/0/18 detail': 'Total cdp entries displayed : 0',
      'show lldp neighbors interface Gi1/0/18 detail': 'Total entries displayed: 0',
      'show lldp neighbors Gi1/0/18 detail': 'Total entries displayed: 0',
    },
  };
  const createSession = async (options) => {
    sessionOptions.push(options);
    const { host } = options;
    return {
    prompt: host === 'core' ? 'CORE#' : 'SW-CAM-07#',
    async connect() {},
    async run(command) {
      executedCommands.push({ host, command });
      return outputs[host][command] || '% Invalid input detected';
    },
    close() {},
    };
  };
  const result = await traceCamera({
    cameraIp: '10.0.63.125', coreHost: 'core', username: 'admin', password: 'secret',
  }, { createSession, emit() {} });
  assert.equal(result.finalDevice, 'SW-CAM-07');
  assert.equal(result.finalPort, 'Gi1/0/18');
  assert.equal(result.hops.length, 2);
  assert.equal(result.hops[0].port, 'Po99');
  assert.equal(result.hops[0].neighborPort, 'Te2/3/1');
  assert.deepEqual(result.hops[0].etherchannel.members.map(({ port }) => port), ['Te1/3/1', 'Te2/3/1']);
  assert.deepEqual(sessionOptions.map(({ username }) => username), ['admin', 'admin']);
  assert.deepEqual(sessionOptions.map(({ password }) => password), ['secret', 'secret']);
  assert.equal(
    executedCommands.some(({ host, command }) => host === '10.0.254.107' && /(?:cdp|lldp).*Gi1\/0\/18/i.test(command)),
    false,
  );
});
