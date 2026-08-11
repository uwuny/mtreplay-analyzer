const MARK = 0x28;
const STOP = 0x2e;
const PROTO = 0x80;
const BININT = 0x4a;
const BININT1 = 0x4b;
const BININT2 = 0x4d;
const LONG1 = 0x8a;
const NONE = 0x4e;
const NEWTRUE = 0x88;
const NEWFALSE = 0x89;
const EMPTY_TUPLE = 0x29;
const TUPLE = 0x74;
const TUPLE1 = 0x85;
const TUPLE2 = 0x86;
const TUPLE3 = 0x87;
const EMPTY_LIST = 0x5d;
const APPENDS = 0x65;
const BINPUT = 0x71;
const LONG_BINPUT = 0x72;
const SHORT_BINSTRING = 0x55;
const BINUNICODE = 0x58;

export class PickleError extends Error {}

export function loadPickle(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stack = [];
  const marks = [];
  let i = 0;

  const popAfterMark = () => {
    if (marks.length === 0) throw new PickleError('TUPLE без MARK');
    return stack.splice(marks.pop());
  };

  while (i < bytes.length) {
    const op = bytes[i++];
    switch (op) {
      case PROTO: i += 1; break;
      case MARK: marks.push(stack.length); break;
      case STOP:
        if (stack.length === 0) throw new PickleError('пустой стек на STOP');
        return stack.pop();

      case BININT1: stack.push(bytes[i]); i += 1; break;
      case BININT2: stack.push(view.getUint16(i, true)); i += 2; break;
      case BININT: stack.push(view.getInt32(i, true)); i += 4; break;
      case LONG1: {
        const n = bytes[i]; i += 1;
        let value = 0n;
        for (let b = n - 1; b >= 0; b--) value = (value << 8n) | BigInt(bytes[i + b]);

        if (n > 0 && bytes[i + n - 1] & 0x80) value -= 1n << BigInt(8 * n);
        i += n;
        stack.push(Number(value));
        break;
      }

      case NONE: stack.push(null); break;
      case NEWTRUE: stack.push(true); break;
      case NEWFALSE: stack.push(false); break;

      case EMPTY_TUPLE: stack.push([]); break;
      case TUPLE: stack.push(popAfterMark()); break;
      case TUPLE1: stack.push([stack.pop()]); break;
      case TUPLE2: { const b = stack.pop(); const a = stack.pop(); stack.push([a, b]); break; }
      case TUPLE3: { const c = stack.pop(); const b = stack.pop(); const a = stack.pop(); stack.push([a, b, c]); break; }

      case EMPTY_LIST: stack.push([]); break;
      case APPENDS: {
        const items = popAfterMark();
        const target = stack[stack.length - 1];
        if (!Array.isArray(target)) throw new PickleError('APPENDS не к списку');
        target.push(...items);
        break;
      }

      case SHORT_BINSTRING: {
        const n = bytes[i]; i += 1;
        stack.push(new TextDecoder('latin1').decode(bytes.subarray(i, i + n)));
        i += n;
        break;
      }
      case BINUNICODE: {
        const n = view.getUint32(i, true); i += 4;
        stack.push(new TextDecoder('utf-8').decode(bytes.subarray(i, i + n)));
        i += n;
        break;
      }

      case BINPUT: i += 1; break;
      case LONG_BINPUT: i += 4; break;

      default:
        throw new PickleError(`неподдерживаемый опкод 0x${op.toString(16)} на позиции ${i - 1}`);
    }
  }
  throw new PickleError('поток кончился без STOP');
}
