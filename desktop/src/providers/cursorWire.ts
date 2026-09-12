/**
 * Cursor `agent.v1` wire format: protobuf codec, Connect framing, and the
 * handful of messages the Chat path actually touches.
 *
 * Cursor speaks Connect RPC over HTTP/2 with binary protobuf — not the
 * OpenAI-compatible JSON every other provider here uses. Rather than take on a
 * protobuf runtime for a schema of which we need roughly fifteen messages, the
 * encoder below writes fields positionally and the decoder hands back raw
 * (field number, bytes) pairs for the caller to interpret. Both directions stay
 * under a hundred lines and the project keeps its single dependency.
 *
 * Field numbers come from the schema embedded in the Cursor CLI; see
 * docs/cursor-protocol.md for how to re-derive them when Cursor moves.
 */

import { Effect } from 'effect';
import { ApiError, ErrorType, runSyncBoundary } from './errors.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Protobuf wire types. Only these three appear in the messages we build. */
const WIRE_VARINT = 0;
const WIRE_LEN = 2;

export function varint(value: number): Uint8Array {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return Uint8Array.from(out);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const EMPTY = new Uint8Array(0);
const tag = (field: number, wire: number): Uint8Array => varint(field * 8 + wire);

/** Proto3 omits zero/false, so a falsy scalar encodes to nothing at all. */
export function encodeVarintField(field: number, value: number | boolean | undefined): Uint8Array {
  const n = value === true ? 1 : value === false || value === undefined ? 0 : value;
  return n === 0 ? EMPTY : concat(tag(field, WIRE_VARINT), varint(n));
}

export function encodeBytesField(field: number, bytes: Uint8Array): Uint8Array {
  return concat(tag(field, WIRE_LEN), varint(bytes.length), bytes);
}

export function encodeStringField(field: number, value: string | undefined): Uint8Array {
  return value ? encodeBytesField(field, encoder.encode(value)) : EMPTY;
}

/**
 * A nested message. Unlike scalars this is emitted even when empty: several
 * `agent.v1` oneof variants (`resumeAction`, `setBlobResult`) carry no fields
 * and are meaningful only by being present.
 */
export function encodeMessageField(field: number, bytes: Uint8Array): Uint8Array {
  return encodeBytesField(field, bytes);
}

export interface ProtoField {
  no: number;
  wire: number;
  /** Varints arrive as numbers; length-delimited fields as their raw bytes. */
  value: number | Uint8Array;
}

export function decodeMessage(buf: Uint8Array): ProtoField[] {
  return runSyncBoundary(decodeMessageEffect(buf));
}

/** Effect version so the Cursor exchange can decode inside an Effect chain. */
export function decodeMessageEffect(buf: Uint8Array): Effect.Effect<ProtoField[], ApiError> {
  return Effect.try({
    try: () => decodeMessageSync(buf),
    catch: (err) =>
      err instanceof ApiError
        ? err
        : new ApiError(
            `cursor: ${err instanceof Error ? err.message : String(err)}`,
            ErrorType.Server,
          ),
  });
}

function decodeMessageSync(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    const [key, afterKey] = readVarint(buf, i);
    i = afterKey;
    const no = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === WIRE_VARINT) {
      const [value, next] = readVarint(buf, i);
      i = next;
      fields.push({ no, wire, value });
    } else if (wire === WIRE_LEN) {
      const [len, next] = readVarint(buf, i);
      i = next;
      fields.push({ no, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      fields.push({ no, wire, value: buf.subarray(i, i + 4) });
      i += 4;
    } else if (wire === 1) {
      fields.push({ no, wire, value: buf.subarray(i, i + 8) });
      i += 8;
    } else {
      // Groups (3, 4) are not used by agent.v1 and cannot be skipped blindly.
      throw new Error(`cursor: unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}

function readVarint(buf: Uint8Array, start: number): [number, number] {
  let result = 0;
  let shift = 1;
  let i = start;
  for (;;) {
    const byte = buf[i++];
    if (byte === undefined) throw new Error('cursor: truncated protobuf varint');
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return [result, i];
    shift *= 128;
  }
}

/** Last-wins, matching proto3 semantics for non-repeated fields. */
export function field(fields: ProtoField[], no: number): number | Uint8Array | undefined {
  let found: number | Uint8Array | undefined;
  for (const f of fields) if (f.no === no) found = f.value;
  return found;
}

export function messageField(fields: ProtoField[], no: number): ProtoField[] | undefined {
  const value = field(fields, no);
  return value instanceof Uint8Array ? decodeMessage(value) : undefined;
}

export function bytesField(fields: ProtoField[], no: number): Uint8Array | undefined {
  const value = field(fields, no);
  return value instanceof Uint8Array ? value : undefined;
}

export function stringField(fields: ProtoField[], no: number): string {
  const value = bytesField(fields, no);
  return value ? decoder.decode(value) : '';
}

export function numberField(fields: ProtoField[], no: number): number {
  const value = field(fields, no);
  return typeof value === 'number' ? value : 0;
}

/** True when the field is present, however empty — how oneof arms are detected. */
export function hasField(fields: ProtoField[], no: number): boolean {
  return fields.some((f) => f.no === no);
}

// Connect streaming framing

export const FLAG_END_STREAM = 0x02;

export function encodeFrame(payload: Uint8Array, flags = 0): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
}

export interface ConnectFrame {
  flags: number;
  payload: Uint8Array;
}

/**
 * Splits whatever whole frames the buffer holds, returning the unconsumed tail.
 * HTTP/2 data events do not align to frame boundaries, so the caller keeps the
 * remainder and feeds it back with the next chunk.
 */
export function readFrames(buf: Uint8Array): { frames: ConnectFrame[]; rest: Uint8Array } {
  const frames: ConnectFrame[] = [];
  let offset = 0;
  for (;;) {
    if (buf.length - offset < 5) break;
    const view = new DataView(buf.buffer, buf.byteOffset + offset);
    const length = view.getUint32(1, false);
    if (buf.length - offset < 5 + length) break;
    frames.push({ flags: buf[offset] ?? 0, payload: buf.subarray(offset + 5, offset + 5 + length) });
    offset += 5 + length;
  }
  return { frames, rest: buf.subarray(offset) };
}
