"""Собирает maps/destructibles/<карта>.bin из пакетов игрового клиента.

В реплее у поломки стоит только номер объекта внутри квадрата карты, а сами
координаты лежат в скомпилированном пространстве карты — res/packages/
<карта>_bin.pkg, файл spaces/<карта>/space.bin, секция WGDE. Оттуда берётся
таблица «квадрат → список объектов» и ссылки на геометрию: деревья лежат в
секции SpTr, остальные модели — в BSMI, у обеих матрица 4×4 с позицией.

Таблица привязана к версии карты: после переработки карты её надо пересобрать.

    python tools/build_destructibles.py "E:/Games/Tanki/res/packages" maps/destructibles

Третьим аргументом можно передать папку с maps/definitions — тогда соберутся
только те карты, которые есть в проекте (по умолчанию maps/definitions).
"""
import glob
import os
import struct
import sys
import zipfile

TABLE_END = 696          # длина оглавления space.bin
CHUNK_SIZE = 100.0       # сторона квадрата карты в метрах
UNKNOWN = -32768         # позиция объекта неизвестна


def read_space(pkg_path):
    with zipfile.ZipFile(pkg_path) as pkg:
        name = next((n for n in pkg.namelist() if n.endswith('space.bin')), None)
        if name is None:
            raise ValueError('в пакете нет space.bin')
        return pkg.read(name)


def sections(data):
    """Оглавление: тег, версия, смещение, длина."""
    out = {}
    at = 0
    while at + 24 <= TABLE_END:
        tag = data[at:at + 4].decode('latin1')
        _, offset, size = struct.unpack_from('<IQQ', data, at + 4)
        if tag != 'BWTB':
            out[tag] = (offset, size)
        at += 24
    return out


def blocks(data, section, limit=4):
    """Секция состоит из блоков [длина записи][число записей][записи]."""
    offset, size = section
    body = data[offset:offset + size]
    at, out = 0, []
    while at + 8 <= len(body) and len(out) < limit:
        record, count = struct.unpack_from('<II', body, at)
        if record == 0 or record * count > len(body) - at - 8:
            break
        out.append((record, count, body[at + 8: at + 8 + record * count]))
        at += 8 + record * count
    return out


def positions(data, section):
    """Позиции из матриц 4×4: перенос лежит в четвёртой строке."""
    record, count, raw = blocks(data, section, 1)[0]
    return [struct.unpack_from('<fff', raw, i * record + 48) for i in range(count)]


def build(pkg_path):
    data = read_space(pkg_path)
    found = sections(data)
    wgde = blocks(data, found['WGDE'])
    if len(wgde) < 3:
        raise ValueError('секция WGDE неполная')

    chunks = [struct.unpack_from('<III', wgde[0][2], i * 12) for i in range(wgde[0][1])]
    bounds = [struct.unpack_from('<II', wgde[1][2], i * 8)[0] for i in range(wgde[1][1])]
    refs = [struct.unpack_from('<I', wgde[2][2], i * 4)[0] for i in range(wgde[2][1])]
    models = positions(data, found['BSMI']) if 'BSMI' in found else []
    trees = positions(data, found['SpTr']) if 'SpTr' in found else []

    def place(index):
        """Первая геометрия объекта: у ссылки старший бит — дерево."""
        start = bounds[index]
        end = bounds[index + 1] if index + 1 < len(bounds) else len(refs)
        for ref in refs[start:end]:
            source = trees if ref & 0x80000000 else models
            at = ref & 0x7fffffff
            if at < len(source):
                return source[at]
        return None

    table, points = [], []
    for chunk_id, start, count in sorted(chunks):
        table.append((chunk_id, len(points), count))
        centre_x = ((chunk_id >> 8) - 127) * CHUNK_SIZE + CHUNK_SIZE / 2
        centre_z = ((chunk_id & 255) - 127) * CHUNK_SIZE + CHUNK_SIZE / 2
        for k in range(count):
            spot = place(start + k)
            if spot is None:
                points.append((UNKNOWN, UNKNOWN))
                continue
            dx = int(round((spot[0] - centre_x) * 100))
            dz = int(round((spot[2] - centre_z) * 100))
            if not (-32000 <= dx <= 32000 and -32000 <= dz <= 32000):
                points.append((UNKNOWN, UNKNOWN))
                continue
            points.append((dx, dz))

    out = bytearray(b'MTD1')
    out += struct.pack('<HHI', 1, len(table), len(points))
    for chunk_id, first, count in table:
        out += struct.pack('<HIH', chunk_id, first, count)
    for dx, dz in points:
        out += struct.pack('<hh', dx, dz)
    known = sum(1 for dx, _ in points if dx != UNKNOWN)
    return bytes(out), len(table), len(points), known


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 1
    packages, dest = argv[1], argv[2]
    definitions = argv[3] if len(argv) > 3 else os.path.join(os.path.dirname(dest), 'definitions')

    os.makedirs(dest, exist_ok=True)
    names = sorted(os.path.basename(p)[:-4] for p in glob.glob(os.path.join(definitions, '*.xml')))
    if not names:
        print('не нашёл карт в %s' % definitions)
        return 1

    total = 0
    for name in names:
        pkg_path = os.path.join(packages, '%s_bin.pkg' % name)
        if not os.path.exists(pkg_path):
            print('%-24s пакета нет' % name)
            continue
        try:
            data, chunks, count, known = build(pkg_path)
        except Exception as err:                                  # noqa: BLE001
            print('%-24s не собралась: %s' % (name, err))
            continue
        with open(os.path.join(dest, name + '.bin'), 'wb') as out:
            out.write(data)
        total += len(data)
        print('%-24s квадратов %4d  объектов %6d  с координатами %6d  %6.1f КБ'
              % (name, chunks, count, known, len(data) / 1024))
    print('итого %.1f КБ в %s' % (total / 1024, dest))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
