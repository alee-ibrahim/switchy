import { describe, expect, it } from 'vitest';
import dgram from 'node:dgram';
import { BirdDogDriver, birddogPresetName } from '../src/engine/cameras/birddog.js';
import { ViscaDriver, fromNibbles, nibbles, parseSonyFrame, sonyFrame, viscaPanTilt, viscaPresetRecall } from '../src/engine/cameras/visca.js';
import { resolveCredentials } from '../src/engine/cameras/types.js';

describe('BirdDog driver', () => {
  it('maps numeric presets to Preset-N and posts JSON to /recall', async () => {
    expect(birddogPresetName('1')).toBe('Preset-1');
    expect(birddogPresetName('Preset-7')).toBe('Preset-7');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const d = new BirdDogDriver({ host: '192.0.2.5', fetchImpl });
    await d.recallPreset('2');
    expect(calls[0]!.url).toBe('http://192.0.2.5:8080/recall');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ Preset: 'Preset-2' });
  });

  it('throws on HTTP errors', async () => {
    const fetchImpl = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await expect(new BirdDogDriver({ host: 'x', fetchImpl }).recallPreset('1')).rejects.toThrow(/500/);
  });
});

describe('VISCA over IP', () => {
  it('builds a Sony-framed preset recall', () => {
    expect(viscaPresetRecall(2).toString('hex')).toBe('8101043f0202ff');
    const f = sonyFrame(0x0100, 5, viscaPresetRecall(2));
    expect(f.toString('hex')).toBe('01000007' + '00000005' + '8101043f0202ff');
    expect(parseSonyFrame(f)).toMatchObject({ type: 0x0100, seq: 5 });
  });

  it('talks to a fake Sony camera: reset, then recall with UI preset 3 -> VISCA 0x02', async () => {
    const got: Buffer[] = [];
    const cam = dgram.createSocket('udp4');
    cam.on('message', (msg, rinfo) => {
      got.push(msg);
      const f = parseSonyFrame(msg)!;
      if (f.type === 0x0200) cam.send(sonyFrame(0x0201, f.seq, Buffer.from([0x01])), rinfo.port, rinfo.address);
      else if (f.type === 0x0100) {
        cam.send(sonyFrame(0x0111, f.seq, Buffer.from([0x90, 0x41, 0xff])), rinfo.port, rinfo.address);
        cam.send(sonyFrame(0x0111, f.seq, Buffer.from([0x90, 0x51, 0xff])), rinfo.port, rinfo.address);
      }
    });
    await new Promise<void>((r) => cam.bind(0, '127.0.0.1', () => r()));
    const port = cam.address().port;
    const d = new ViscaDriver({ host: '127.0.0.1', port });
    await d.recallPreset('3');
    await d.recallPreset('1');
    d.close();
    cam.close();
    expect(parseSonyFrame(got[0]!)!.type).toBe(0x0200); // RESET first
    expect(parseSonyFrame(got[1]!)!.payload.toString('hex')).toBe('8101043f0202ff');
    expect(parseSonyFrame(got[2]!)!.payload.toString('hex')).toBe('8101043f0200ff');
  });

  it('encodes pan/tilt moves as signed nibbles', () => {
    expect(nibbles(0x1234)).toEqual([1, 2, 3, 4]);
    expect(nibbles(-1)).toEqual([0xf, 0xf, 0xf, 0xf]);
    expect(fromNibbles([0xf, 0xf, 0xf, 0xe])).toBe(-2);
    expect(viscaPanTilt('relative', -16, 32, 0x08, 0x08).toString('hex')).toBe('810106030808' + '0f0f0f00' + '00000200' + 'ff');
  });

  it('reports VISCA errors', async () => {
    const cam = dgram.createSocket('udp4');
    cam.on('message', (msg, rinfo) =>
      cam.send(Buffer.from([0x90, 0x60, 0x41, 0xff]), rinfo.port, rinfo.address),
    );
    await new Promise<void>((r) => cam.bind(0, '127.0.0.1', () => r()));
    const d = new ViscaDriver({ host: '127.0.0.1', port: cam.address().port, framing: 'raw' });
    await expect(d.recallPreset('1')).rejects.toThrow(/not executable/);
    d.close();
    cam.close();
  });
});

describe('credentials', () => {
  it('come from env by reference, never from config', () => {
    const env = { SWITCHY_CRED_SONY_R12_USERNAME: 'admin', SWITCHY_CRED_SONY_R12_PASSWORD: 'pw' };
    expect(resolveCredentials('sony-r12', env)).toEqual({ username: 'admin', password: 'pw' });
    expect(resolveCredentials('missing', env)).toBeNull();
    expect(resolveCredentials(null, env)).toBeNull();
  });
});
