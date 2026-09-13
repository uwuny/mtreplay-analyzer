/**
 * Тип боя (ARENA_BONUS_TYPE) → режим. teamSize — сколько машин в команде,
 * clanTeams — собирается ли команда кланом: в случайном бою клан команды не
 * определить, там у каждого игрока свой тег.
 */
export const BATTLE_MODES = {
  1: { key: 'random', name: 'Случайный бой', teamSize: 15, clanTeams: false },
  20: { key: 'sortie', name: 'Вылазки', teamSize: 7, clanTeams: true },
  43: { key: 'onslaught', name: 'Натиск', teamSize: 7, clanTeams: true },
};
