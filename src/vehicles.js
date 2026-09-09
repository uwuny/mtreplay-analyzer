import { openPacked, packedOwnValue, sectionOf, valueOf } from './bigworld.js?v=1';

const SHELL_KINDS = {
  ARMOR_PIERCING: { short: 'ББ', full: 'бронебойный' },
  ARMOR_PIERCING_CR: { short: 'БП', full: 'подкалиберный' },
  HOLLOW_CHARGE: { short: 'КС', full: 'кумулятивный' },
  HIGH_EXPLOSIVE: { short: 'ОФ', full: 'осколочно-фугасный' },
  ARMOR_PIERCING_HE: { short: 'ББ-ОФ', full: 'бронебойно-фугасный' },
  SMOKE: { short: 'ДС', full: 'дымовой' },
  FLAME: { short: 'ЗЖ', full: 'зажигательный' },
};

export function shellKindLabel(kind) {
  return SHELL_KINDS[kind] || { short: kind || '—', full: '' };
}

function num(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNum(value) {
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  if (typeof value === 'string') return num(value.trim().split(/\s+/)[0]);
  return num(value);
}

function isSection(value) {
  return Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0].name !== undefined;
}

/**
 * Толщина брони по имени материала. В XML значение лежит либо прямо
 * (`<armor_1> 160`), либо как собственный текст секции с уточнениями
 * (`<armor_9> 30 <vehicleDamageFactor> 0 </armor_9>`).
 */
function readArmorTable(file, section) {
  if (!Array.isArray(section)) return null;

  const table = {};
  for (const entry of section) {
    const value = valueOf(file, entry);
    if (isSection(value)) {
      const mm = packedOwnValue(file.bytes, file.view, entry);
      const factor = num(sectionOf(file, value, 'vehicleDamageFactor'));
      const material = { mm: mm === null ? 0 : mm };
      if (factor !== null && factor !== 1) material.df = factor;
      table[entry.name] = material;
    } else {
      const mm = num(value);
      if (mm !== null) table[entry.name] = { mm };
    }
  }
  return table;
}

/** Имя коллизионной модели узла — оно же имя группы мешей в .obj. */
function collisionKey(file, node) {
  const models = sectionOf(file, node, 'models');
  if (!isSection(models)) return null;
  const undamaged = sectionOf(file, models, 'undamaged');
  if (typeof undamaged !== 'string') return null;
  return undamaged.split('/').pop().replace(/\.model$/i, '');
}

function readShot(file, shotSection) {
  return {
    speed: num(sectionOf(file, shotSection, 'speed')),
    piercing: firstNum(sectionOf(file, shotSection, 'piercingPower')),
    max_distance: num(sectionOf(file, shotSection, 'maxDistance')),
  };
}

function readShell(file, shellSection) {
  const damage = sectionOf(file, shellSection, 'damage');
  const kind = sectionOf(file, shellSection, 'kind');
  return {
    kind: typeof kind === 'string' ? kind : null,
    caliber: num(sectionOf(file, shellSection, 'caliber')),
    damage: isSection(damage) ? num(sectionOf(file, damage, 'armor')) : null,
    devices_damage: isSection(damage) ? num(sectionOf(file, damage, 'devices')) : null,
    effects: sectionOf(file, shellSection, 'effects') || null,
    explosion_radius: num(sectionOf(file, shellSection, 'explosionRadius')),
  };
}

function collectGuns(file) {
  const guns = [];
  for (const turretEntry of sectionOf(file, file.root, 'turrets0') || []) {
    const turret = valueOf(file, turretEntry);
    if (!isSection(turret)) continue;
    for (const gunEntry of sectionOf(file, turret, 'guns') || []) {
      const gun = valueOf(file, gunEntry);
      if (isSection(gun)) guns.push({ name: gunEntry.name, node: gun });
    }
  }
  return guns;
}

// Имена записей в shot_effects.xml — это класс калибра плюс тип снаряда.
const EFFECT_SUFFIX = {
  ARMOR_PIERCING: 'ArmorPiercing',
  ARMOR_PIERCING_CR: 'APCR',
  HOLLOW_CHARGE: 'HollowCharge',
  HIGH_EXPLOSIVE: 'HighExplosive',
};

const EFFECT_CLASSES = ['superhuge', 'huge', 'large', 'main', 'medium', 'small', 'auto'];

function effectClass(name, kind) {
  const suffix = EFFECT_SUFFIX[kind];
  if (typeof name !== 'string' || !suffix || !name.endsWith(suffix)) return null;
  const prefix = name.slice(0, name.length - suffix.length);
  return EFFECT_CLASSES.includes(prefix) ? prefix : null;
}

/**
 * Часть снарядов хранит `effects` не строкой, а упакованной ссылкой, которую
 * распаковщик прочитать не может. Класс калибра для них восстанавливается по
 * соседнему снаряду той же пушки, а если и там пусто — по калибру.
 */
function readEffectClassesByCaliber(shells) {
  const votes = new Map();
  if (!shells) return new Map();

  for (const entry of shells.root) {
    const section = valueOf(shells, entry);
    if (!isSection(section)) continue;
    const cls = effectClass(sectionOf(shells, section, 'effects'), sectionOf(shells, section, 'kind'));
    const caliber = num(sectionOf(shells, section, 'caliber'));
    if (!cls || caliber === null) continue;
    if (!votes.has(caliber)) votes.set(caliber, new Map());
    const perClass = votes.get(caliber);
    perClass.set(cls, (perClass.get(cls) || 0) + 1);
  }

  const result = new Map();
  for (const [caliber, perClass] of votes) {
    let best = null;
    for (const [cls, count] of perClass) if (!best || count > best[1]) best = [cls, count];
    result.set(caliber, best[0]);
  }
  return result;
}

function gunShots(file, gun, sharedGuns) {
  const own = sectionOf(file, gun.node, 'shots');
  if (isSection(own)) return { file, shots: own };
  if (!sharedGuns) return null;

  const shared = sectionOf(sharedGuns, sharedGuns.root, 'shared') || sharedGuns.root;
  const gunNode = sectionOf(sharedGuns, shared, gun.name);
  if (!isSection(gunNode)) return null;

  const shots = sectionOf(sharedGuns, gunNode, 'shots');
  return isSection(shots) ? { file: sharedGuns, shots } : null;
}

function readArmor(file) {
  const armor = {};
  const add = (node) => {
    if (!isSection(node)) return;
    const key = collisionKey(file, node);
    const table = readArmorTable(file, sectionOf(file, node, 'armor'));
    if (key && table) armor[key] = table;
  };

  add(sectionOf(file, file.root, 'hull'));
  for (const entry of sectionOf(file, file.root, 'chassis') || []) add(valueOf(file, entry));
  for (const turretEntry of sectionOf(file, file.root, 'turrets0') || []) {
    const turret = valueOf(file, turretEntry);
    add(turret);
    if (!isSection(turret)) continue;
    for (const gunEntry of sectionOf(file, turret, 'guns') || []) add(valueOf(file, gunEntry));
  }
  return armor;
}

/**
 * Снаряды танка: пушки перечисляют выстрелы, свойства снаряда лежат
 * в общих для нации shells.xml, скорость и бронепробитие — в guns.xml.
 * Ключ, по которому снаряд опознаётся в реплее, — индекс его записи
 * в shot_effects.xml.
 */
function readShells(file, sharedGuns, shells, effectIndexes, classByCaliber) {
  const byEffect = new Map();

  for (const gun of collectGuns(file)) {
    const source = gunShots(file, gun, sharedGuns);
    if (!source) continue;

    const loaded = [];
    for (const shotEntry of source.shots) {
      const shotSection = valueOf(source.file, shotEntry);
      const shellSection = shells ? sectionOf(shells, shells.root, shotEntry.name) : null;
      if (!isSection(shotSection) || !isSection(shellSection)) continue;
      loaded.push({ name: shotEntry.name, ...readShell(shells, shellSection), ...readShot(source.file, shotSection) });
    }

    const gunClass = loaded.map((shell) => effectClass(shell.effects, shell.kind)).find(Boolean)
      || classByCaliber.get(loaded[0]?.caliber)
      || null;

    for (const shell of loaded) {
      let index = effectIndexes.get(shell.effects);
      if (index === undefined && gunClass && EFFECT_SUFFIX[shell.kind]) {
        shell.effects = gunClass + EFFECT_SUFFIX[shell.kind];
        index = effectIndexes.get(shell.effects);
      }
      if (index === undefined) continue;

      shell.effects_index = index;
      // Верхняя пушка идёт в XML последней — она и должна победить.
      byEffect.set(index, shell);
    }
  }

  return [...byEffect.values()].sort((a, b) => a.effects_index - b.effects_index);
}

function splitVehicleType(vehicleType) {
  const at = String(vehicleType || '').indexOf(':');
  if (at === -1) return null;
  return { nation: vehicleType.slice(0, at), name: vehicleType.slice(at + 1) };
}

/**
 * Сводка по технике боя: толщина брони каждого материала коллизионной
 * модели и боекомплект. Всё берётся из распакованных игровых XML в `vehicles/`.
 */
export async function buildVehicleDb(vehicleTypes, { loadGameXml }) {
  const open = async (path) => {
    try {
      return openPacked(await loadGameXml(path));
    } catch {
      return null;
    }
  };

  const effects = await open('common/shot_effects.xml');
  const effectIndexes = new Map();
  if (effects) effects.root.forEach((entry, index) => effectIndexes.set(entry.name, index));

  const common = await open('common/vehicle_common.xml');
  const extras = [];
  if (common) {
    for (const entry of sectionOf(common, common.root, 'extras') || []) extras.push(entry.name);
  }

  const nationCache = new Map();
  const nationFiles = async (nation) => {
    if (!nationCache.has(nation)) {
      nationCache.set(nation, Promise.all([
        open(`${nation}/components/guns.xml`),
        open(`${nation}/components/shells.xml`),
      ]).then(([guns, shells]) => ({ guns, shells, classByCaliber: readEffectClassesByCaliber(shells) })));
    }
    return nationCache.get(nation);
  };

  const vehicles = {};
  for (const vehicleType of new Set(vehicleTypes)) {
    const parts = splitVehicleType(vehicleType);
    if (!parts) continue;

    const file = await open(`${parts.nation}/${parts.name}.xml`);
    if (!file) continue;

    const { guns, shells, classByCaliber } = await nationFiles(parts.nation);
    vehicles[vehicleType] = {
      armor: readArmor(file),
      shells: readShells(file, guns, shells, effectIndexes, classByCaliber),
    };
  }

  return { vehicles, extras };
}
