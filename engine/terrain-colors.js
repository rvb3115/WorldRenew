// Approximate material colors, never a block-state transformation or game registry.
const colors = {
  grass_block: 0x729b43, podzol: 0x806343, mycelium: 0x857487,
  water: 0x387cbb, lava: 0xf07824, sand: 0xdcd09a, red_sand: 0xb96c35,
  snow: 0xe9eff0, snow_block: 0xe9eff0, powder_snow: 0xe5edf0,
  ice: 0x89badb, packed_ice: 0x7cadd5, blue_ice: 0x689bd2,
  netherrack: 0x8b4444, soul_sand: 0x655045, soul_soil: 0x564438,
  crimson_nylium: 0x962f42, warped_nylium: 0x348781,
  nether_wart_block: 0x841e2c, warped_wart_block: 0x267768,
  end_stone: 0xd8d99e, obsidian: 0x33283f, crying_obsidian: 0x634682,
  bedrock: 0x52545a, nether_portal: 0x9f5aca, end_portal: 0x152c30,
  dirt: 0x8b6744, coarse_dirt: 0x886546, rooted_dirt: 0x95734c,
  mud: 0x635c58, clay: 0xa4acb7, gravel: 0x92908a,
  stone: 0x8b8d88, granite: 0x9a7264, diorite: 0xbbbab4, andesite: 0x92968f,
  calcite: 0xd8d6c5, tuff: 0x777d6a, basalt: 0x5c5c60, smooth_basalt: 0x59595b,
  copper_block: 0xb36c4e, oxidized_copper: 0x4c9b7a, bricks: 0xaa6658,
  glowstone: 0xd8ad62, sea_lantern: 0xb5d4ca, magma_block: 0xc65f28,
  dirt_path: 0xac905b, farmland: 0x795331
};
const dyes = { white:0xdedfd8, orange:0xdb7b27, magenta:0xae49ae, light_blue:0x60a5cf, yellow:0xdfb52f, lime:0x7dad33, pink:0xd993ae, gray:0x53585b, light_gray:0xa4a49a, cyan:0x2d8595, purple:0x76439e, blue:0x3c4fa6, brown:0x775039, green:0x5b762f, red:0xa93732, black:0x303237 };
const woods = { oak:0xb0945b, spruce:0x715337, birch:0xd5c48c, jungle:0xb17d56, acacia:0xb36842, dark_oak:0x503b28, mangrove:0x88473f, cherry:0xdba8a3, pale_oak:0xd9d6c1, bamboo:0xb4ad50, crimson:0x823f5a, warped:0x3c8580 };
export function terrainColor(name) {
  if (!name?.startsWith('minecraft:')) return { rgb: 0xc18ed0, approximate: true };
  const n = name.slice(10);
  if (colors[n] !== undefined) return { rgb: colors[n], approximate: false };
  for (const [dye, rgb] of Object.entries(dyes)) if (n.startsWith(dye + '_') && /concrete|terracotta|wool|carpet|glass|shulker/.test(n)) return { rgb, approximate: false };
  if (/leaves$|moss|azalea|fern|grass|vine|lily_pad|cactus/.test(n)) return { rgb: /cherry/.test(n) ? 0xdca1b4 : 0x4f803b, approximate: false };
  for (const [wood, rgb] of Object.entries(woods)) if (n.startsWith(wood + '_') || n.startsWith('stripped_' + wood + '_')) return { rgb, approximate: false };
  const families = [[/deepslate|blackstone|coal/,0x4d5256],[/sandstone/,0xcab887],[/quartz/,0xdcd8c9],[/purpur/,0xa57ba7],[/prismarine/,0x5f9b8c],[/cobblestone|stone_brick|smooth_stone/,0x858981],[/glass/,0xa2c5cb],[/terracotta/,0xa3755e],[/iron/,0xb9b8b4],[/gold/,0xe2bb3e],[/diamond/,0x62c5bf],[/emerald/,0x41aa62],[/redstone/,0xa12a2a],[/lapis/,0x3d5caa],[/wheat|hay_block/,0xc7b458]];
  for (const [pattern, rgb] of families) if (pattern.test(n)) return { rgb, approximate: false };
  return { rgb: 0xc18ed0, approximate: true };
}
