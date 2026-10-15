# ONLY in a newly created disposable vanilla Java 26.3 world.
# No load/tick hooks: invoked manually after adding the player tag below.
execute if entity @s[tag=worldrenew_qa_disposable] in minecraft:overworld run function worldrenew_qa:overworld
execute if entity @s[tag=worldrenew_qa_disposable] in minecraft:the_nether run function worldrenew_qa:nether
execute if entity @s[tag=worldrenew_qa_disposable] in minecraft:the_end run function worldrenew_qa:end
execute if entity @s[tag=worldrenew_qa_disposable] in minecraft:overworld run setworldspawn 8 65 8
execute if entity @s[tag=worldrenew_qa_disposable] in minecraft:overworld run tp @s 8 65 8
execute if entity @s[tag=worldrenew_qa_disposable] run give @s minecraft:diamond 17
execute if entity @s[tag=worldrenew_qa_disposable] run experience set @s 42 levels
