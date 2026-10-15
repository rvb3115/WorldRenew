# Absolute coordinates; disposable world only. Scaffold, not a functioning farm.
fill 0 64 0 15 64 15 minecraft:oak_planks
fill 0 65 0 15 72 15 minecraft:air
setblock 2 65 2 minecraft:hopper[facing=down]
setblock 3 65 2 minecraft:chest
setblock 4 65 2 minecraft:rail
setblock 5 65 2 minecraft:red_bed[facing=east,part=foot]
setblock 6 65 2 minecraft:red_bed[facing=east,part=head]
setblock 7 65 2 minecraft:comparator[facing=north]
fill 7 64 8 10 68 8 minecraft:obsidian
fill 8 65 8 9 67 8 minecraft:nether_portal[axis=x]
summon minecraft:villager 5.5 65 5.5
# Explicitly generate the intended distant refresh chunk with a disposable marker.
setblock 72 64 8 minecraft:gold_block
