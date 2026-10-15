fill 0 64 0 15 64 15 minecraft:end_stone
fill 0 65 0 15 72 15 minecraft:air
setblock 2 65 2 minecraft:hopper[facing=down]
setblock 3 65 2 minecraft:chest
setblock 4 65 2 minecraft:rail
summon minecraft:endermite 8.5 65 5.5
# Set up a platform and gateway block. Its actual saved destination must be
# inspected and tested in-game; this scaffold does not certify gateway linking.
fill 96 74 0 111 74 15 minecraft:end_stone
setblock 8 65 8 minecraft:end_gateway
