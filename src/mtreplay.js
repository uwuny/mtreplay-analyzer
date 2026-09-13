import { Blowfish } from './blowfish.js?v=2';

export const REPLAY_MAGIC = 0x11343212;
export const PACKET_HEADER_SIZE = 12;
export const END_OF_STREAM_TYPE = 0xffffffff;
export const MAX_PACKET_PAYLOAD_SIZE = 1024 * 1024;

const MT_KEY = Uint8Array.from([
  0xde, 0x72, 0xbe, 0xa0, 0xde, 0x04, 0xbe, 0xb1,
  0xde, 0xfe, 0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef,
]);

export class ReplayFormatError extends Error {}

export function decryptReplay(encrypted) {
  if (encrypted.length % 8 !== 0) {
    throw new ReplayFormatError('encrypted stream size is not aligned');
  }
  if (encrypted.length === 0) return new Uint8Array(0);

  const plain = new Blowfish(MT_KEY).decryptEcb(encrypted);

  const words = new Uint32Array(plain.buffer, 0, plain.length >>> 2);
  for (let i = 2; i < words.length; i += 2) {
    words[i] ^= words[i - 2];
    words[i + 1] ^= words[i - 1];
  }
  return plain;
}

async function inflateExact(data) {
  const stream = new Response(data).body.pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflate(data) {
  let firstError = null;
  for (let trim = 0; trim <= 7 && trim < data.length; trim++) {
    try {
      return await inflateExact(trim === 0 ? data : data.subarray(0, data.length - trim));
    } catch (err) {
      if (firstError === null) firstError = err;
    }
  }
  throw new ReplayFormatError(`не удалось распаковать zlib-поток: ${firstError && firstError.message}`);
}

function readBlocks(bytes, view) {
  if (bytes.length < 8) {
    throw new ReplayFormatError(`файл слишком короткий (${bytes.length} байт)`);
  }
  const magic = view.getUint32(0, true);
  if (magic !== REPLAY_MAGIC) {
    throw new ReplayFormatError(
      `неверная сигнатура файла: 0x${magic.toString(16)}, ожидалась 0x${REPLAY_MAGIC.toString(16)}`,
    );
  }

  const blockCount = view.getUint32(4, true);
  if (blockCount > 32) {
    throw new ReplayFormatError(`неправдоподобное количество блоков: ${blockCount}`);
  }

  const decoder = new TextDecoder('utf-8');
  const blocks = [];
  let offset = 8;
  for (let i = 0; i < blockCount; i++) {
    if (offset + 4 > bytes.length) {
      throw new ReplayFormatError(`файл обрывается на заголовке блока #${i}`);
    }
    const size = view.getUint32(offset, true);
    if (offset + 4 + size > bytes.length) {
      throw new ReplayFormatError(`блок #${i} не помещается в файл`);
    }
    blocks.push(decoder.decode(bytes.subarray(offset + 4, offset + 4 + size)));
    offset += 4 + size;
  }
  return { blocks, offset };
}

const VERSION_KEYS = ['version', 'clientVersionFromExe', 'clientVersionFromXml'];

export function parsePacketStream(data, { decoders = null, onProgress = null } = {}) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const packets = [];
  let offset = 0;
  let count = 0;

  while (offset + PACKET_HEADER_SIZE <= data.length) {
    const payloadSize = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const headerUnknown = view.getUint32(offset + 8, true);

    if (type === END_OF_STREAM_TYPE) break;
    if (payloadSize > MAX_PACKET_PAYLOAD_SIZE) break;

    const totalSize = payloadSize + PACKET_HEADER_SIZE;
    if (offset + totalSize > data.length) break;

    const packet = { offset, type, payloadSize, headerUnknown, totalSize, decoded: null };

    const decoder = decoders && decoders[type];
    if (decoder) {
      const packetView = new DataView(data.buffer, data.byteOffset + offset, totalSize);
      try {
        packet.decoded = decoder(packetView, data.subarray(offset, offset + totalSize));
      } catch (err) {
        packet.decoded = { error: `Decode failed: ${err.message}` };
      }
    }

    packets.push(packet);
    offset += totalSize;
    count++;
    if (onProgress && count % 10000 === 0) onProgress(count);
  }

  return packets;
}

export async function parseReplay(arrayBuffer, options = {}) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  const { blocks, offset } = readBlocks(bytes, view);
  const gameBegin = blocks.length > 0 ? JSON.parse(blocks[0]) : {};
  const playerInfo = blocks.length > 1 ? JSON.parse(blocks[1]) : {};
  const gameEnd = blocks.length > 2 ? JSON.parse(blocks[2]) : null;

  let version = 'unknown';
  for (const key of VERSION_KEYS) {
    if (gameBegin && gameBegin[key]) {
      version = String(gameBegin[key]);
      break;
    }
  }

  const encrypted = bytes.subarray(offset + 8);
  if (encrypted.length === 0) {
    return { gameBegin, playerInfo, gameEnd, version, packets: [] };
  }

  const stream = await (options.inflate || inflate)(decryptReplay(encrypted));
  const packets = parsePacketStream(stream, options);

  return { gameBegin, playerInfo, gameEnd, version, packets, stream };
}
