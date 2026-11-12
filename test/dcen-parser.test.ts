import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { LineSplitter, formatUnit, parseLine, parseUnit } from '../src/engine/dcen/parser.js';
import { DcenClient } from '../src/engine/dcen/client.js';
import type { DcenEvent } from '../src/engine/dcen/parser.js';

const DUMP =
  'MICMODE;AUT-NEXT\r\nMAXDEL;2;\r\nMAXVIP;2;\r\nVOLUME;;\r\nPRIOMODE;OFF\r\nMUTEMODE;PERM\r\nPRIOSTATE;OFF\r\nMUTESTATE;OFF\r\nMIC-OFF;FFFF;FFFF;\r\nLANG;1;ENG;\r\nLANG;2;OTH;\r\nREADY;';

describe('parseUnit', () => {
  it('parses 4-digit hex unit ids', () => {
    expect(parseUnit('0003')).toBe(3);
    expect(parseUnit('001A')).toBe(26);
    expect(parseUnit('001a')).toBe(26);
    expect(parseUnit('FFFF')).toBe('all');
    expect(parseUnit('')).toBeNull();
    expect(parseUnit('xyz')).toBeNull();
    expect(formatUnit(26)).toBe('001A');
  });
});

describe('parseLine', () => {
  it('parses real DCen lines', () => {
    expect(parseLine('MIC-ON;0003;;')).toEqual({ type: 'mic-on', unit: 3, raw: 'MIC-ON;0003;;' });
    expect(parseLine('MIC-OFF;0003;;')).toMatchObject({ type: 'mic-off', unit: 3 });
    expect(parseLine('MIC-ON;001A;;')).toMatchObject({ type: 'mic-on', unit: 26 });
    expect(parseLine('MIC-OFF;FFFF;FFFF;')).toMatchObject({ type: 'mic-off', unit: 'all' });
    expect(parseLine('KEYS;0003;;00000;')).toMatchObject({ type: 'keys', unit: 3, keys: '00000' });
    expect(parseLine('READY;')).toMatchObject({ type: 'ready' });
    expect(parseLine('MICMODE;AUT-NEXT')).toMatchObject({ type: 'setting', key: 'MICMODE', values: ['AUT-NEXT'] });
    expect(parseLine('LANG;1;ENG;')).toMatchObject({ type: 'setting', key: 'LANG', values: ['1', 'ENG'] });
    expect(parseLine('VOLUME;;')).toMatchObject({ type: 'setting', key: 'VOLUME', values: [] });
    expect(parseLine('')).toMatchObject({ type: 'keepalive' });
    expect(parseLine('   ')).toMatchObject({ type: 'keepalive' });
    expect(parseLine('MIC-ON;;;')).toMatchObject({ type: 'unknown' });
    expect(parseLine('SOMETHING;1')).toMatchObject({ type: 'unknown' });
  });
});

describe('LineSplitter', () => {
  it('splits CRLF once, keeps an unterminated tail until flush', () => {
    const s = new LineSplitter();
    const lines = s.push(DUMP);
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe('MICMODE;AUT-NEXT');
    expect(lines[10]).toBe('LANG;2;OTH;');
    expect(s.hasPending).toBe(true);
    expect(s.flush()).toBe('READY;');
    expect(s.flush()).toBeNull();
  });

  it('handles CRLF split across chunks and keep-alive empty lines', () => {
    const s = new LineSplitter();
    expect(s.push('MIC-ON;0003;;\r')).toEqual(['MIC-ON;0003;;']);
    expect(s.push('\nMIC-OF')).toEqual([]);
    expect(s.push('F;0003;;\r\n\r\n')).toEqual(['MIC-OFF;0003;;', '']);
    expect(s.push('\n')).toEqual(['']); // bare LF
  });
});

describe('DcenClient (against a fake DCen)', () => {
  it('parses the connect dump, flushes READY; without CRLF, never writes, reconnects', async () => {
    let received = 0;
    let conns = 0;
    const server = net.createServer((sock) => {
      conns++;
      sock.on('data', (d) => (received += d.length));
      if (conns === 1) {
        // split the dump into odd chunks
        sock.write(DUMP.slice(0, 37));
        setTimeout(() => sock.write(DUMP.slice(37)), 20);
        setTimeout(() => sock.write('\r\nKEYS;001A;;00000;\r\nMIC-ON;001A;;\r\n'), 500);
        setTimeout(() => sock.destroy(), 600);
      } else {
        sock.write('READY;');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const c = new DcenClient({ host: '127.0.0.1', port, minBackoffMs: 50, flushMs: 100 });
    const events: DcenEvent[] = [];
    const conn: string[] = [];
    c.on('event', (e) => events.push(e));
    c.on('connected', () => conn.push('up'));
    c.on('disconnected', () => conn.push('down'));
    c.start();
    await new Promise((r) => setTimeout(r, 1000));
    c.stop();
    server.close();
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'ready')).toHaveLength(2); // flushed after quiet, both connections
    expect(events.find((e) => e.type === 'mic-on')).toMatchObject({ unit: 26 });
    expect(types.indexOf('ready')).toBeLessThan(types.indexOf('mic-on'));
    expect(conn.slice(0, 3)).toEqual(['up', 'down', 'up']);
    expect(received).toBe(0);
  });
});
