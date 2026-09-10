/**
 * Test-only decoder for durable DSH session logs.
 *
 * A `session.v3.jsonl.zstd` file is a CONCATENATION of independent zstd frames,
 * one per durable write batch. Neither `zlib.zstdDecompressSync(buffer)` nor the
 * stream decoder drains them — both stop after the first frame — so the frame
 * boundaries are walked here per RFC 8878 and each frame is decompressed on its
 * own. This mirrors what `@deepseek-ai/dsh-session-persistence-jsonl` does
 * internally; it exists so the token fold can be cross-checked against real
 * recorded usage without booting a server.
 *
 * @module dsh-token-stats/test/decode-session
 */
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

/**
 * Split a concatenated zstd buffer into structurally complete frames.
 * @param buffer - the whole file.
 * @returns one subarray per frame, in order.
 */
export function splitZstdFrames(buffer) {
  const frames = [];
  let position = 0;
  while (position < buffer.length) {
    const start = position;
    if (buffer[position] !== 0x28 || buffer[position + 1] !== 0xb5 || buffer[position + 2] !== 0x2f || buffer[position + 3] !== 0xfd) {
      throw new Error('corrupt zstd session log: invalid frame magic at byte ' + position);
    }
    position += 4;
    const descriptor = buffer[position];
    position += 1;
    const contentSizeCode = (descriptor >> 6) & 0x03;
    const singleSegment = (descriptor >> 5) & 0x01;
    const checksum = (descriptor >> 2) & 0x01;
    const dictionaryFlag = descriptor & 0x03;
    if (!singleSegment) position += 1;
    position += [0, 1, 2, 4][dictionaryFlag];
    position += contentSizeCode === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeCode];
    for (;;) {
      const header = buffer[position] | (buffer[position + 1] << 8) | (buffer[position + 2] << 16);
      const last = header & 1;
      const blockType = (header >> 1) & 3;
      const blockSize = header >> 3;
      position += 3;
      position += blockType === 1 ? 1 : blockSize;
      if (last) break;
    }
    if (checksum) position += 4;
    frames.push(buffer.subarray(start, position));
  }
  return frames;
}

/**
 * Decode a whole session log.
 * @param file - path to a `.jsonl.zstd` log.
 * @returns `{ header, events }` with every line parsed.
 */
export function decodeSessionLog(file) {
  const raw = readFileSync(file);
  const text = splitZstdFrames(raw).map((frame) => zlib.zstdDecompressSync(frame).toString('utf8')).join('');
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  return { header: JSON.parse(lines[0]), events: lines.slice(1).map((line) => JSON.parse(line)) };
}

/**
 * Slice a log into complete Turn ranges.
 * @param events - decoded events.
 * @returns one array per `turn/start`…`turn/end` pair.
 */
export function turnsOf(events) {
  const turns = [];
  let start = -1;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].type === 'turn/start') start = i;
    else if (events[i].type === 'turn/end' && start >= 0) {
      turns.push(events.slice(start, i + 1));
      start = -1;
    }
  }
  return turns;
}
