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
const APPEND = 0x61;
const APPENDS = 0x65;
const EMPTY_DICT = 0x7d;
const SETITEM = 0x73;
const SETITEMS = 0x75;
const BINFLOAT = 0x47;
const BINPUT = 0x71;
const LONG_BINPUT = 0x72;
const BINGET = 0x68;
const LONG_BINGET = 0x6a;
const GLOBAL = 0x63;
const REDUCE = 0x52;
const SHORT_BINSTRING = 0x55;
const BINUNICODE = 0x58;

export class PickleError extends Error {}

/**
 * Классы из игры (`_BWp.FixedDict`, `copy_reg._reconstructor`) не воссоздаются:
 * от них нужны только аргументы конструктора. Одиночный аргумент разворачивается,
 * поэтому словарь именованных полей приходит на стек как обычный объект.
 */
function reduceValue(args) {
  if (Array.isArray(args) && args.length === 1) return args[0];
  return args;
}

export function loadPickle(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin = new TextDecoder('latin1');
  const stack = [];
  const marks = [];
  const memo = new Map();
  let i = 0;

  const popAfterMark = () => {
    if (marks.length === 0) throw new PickleError('TUPLE без MARK');
    return stack.splice(marks.pop());
  };

  const readLine = () => {
    const end = bytes.indexOf(0x0a, i);
    if (end === -1) throw new PickleError('строка без перевода строки');
    const text = latin.decode(bytes.subarray(i, end));
    i = end + 1;
    return text;
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
      case BINFLOAT: stack.push(view.getFloat64(i, false)); i += 8; break;
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
      case APPEND: {
        const item = stack.pop();
        const target = stack[stack.length - 1];
        if (!Array.isArray(target)) throw new PickleError('APPEND не к списку');
        target.push(item);
        break;
      }
      case APPENDS: {
        const items = popAfterMark();
        const target = stack[stack.length - 1];
        if (!Array.isArray(target)) throw new PickleError('APPENDS не к списку');
        target.push(...items);
        break;
      }

      case EMPTY_DICT: stack.push({}); break;
      case SETITEM: {
        const value = stack.pop();
        const key = stack.pop();
        const target = stack[stack.length - 1];
        if (target === null || typeof target !== 'object') throw new PickleError('SETITEM не к словарю');
        target[key] = value;
        break;
      }
      case SETITEMS: {
        const items = popAfterMark();
        const target = stack[stack.length - 1];
        if (target === null || typeof target !== 'object') throw new PickleError('SETITEMS не к словарю');
        for (let k = 0; k + 1 < items.length; k += 2) target[items[k]] = items[k + 1];
        break;
      }

      case SHORT_BINSTRING: {
        const n = bytes[i]; i += 1;
        stack.push(latin.decode(bytes.subarray(i, i + n)));
        i += n;
        break;
      }
      case BINUNICODE: {
        const n = view.getUint32(i, true); i += 4;
        stack.push(new TextDecoder('utf-8').decode(bytes.subarray(i, i + n)));
        i += n;
        break;
      }

      case GLOBAL: {
        const module = readLine();
        stack.push({ pickle_global: `${module}.${readLine()}` });
        break;
      }
      case REDUCE: {
        const args = stack.pop();
        stack.pop();
        stack.push(reduceValue(args));
        break;
      }

      case BINPUT: memo.set(bytes[i], stack[stack.length - 1]); i += 1; break;
      case LONG_BINPUT: memo.set(view.getUint32(i, true), stack[stack.length - 1]); i += 4; break;
      case BINGET: stack.push(memo.get(bytes[i])); i += 1; break;
      case LONG_BINGET: stack.push(memo.get(view.getUint32(i, true))); i += 4; break;

      default:
        throw new PickleError(`неподдерживаемый опкод 0x${op.toString(16)} на позиции ${i - 1}`);
    }
  }
  throw new PickleError('поток кончился без STOP');
}
