# Java 1.21.11 terrain adapter

The 0.5.5 map rejected an otherwise inspectable 1.21.11 world because terrain preview allowed only 26.2 and 26.3. The 0.5.6 development build adds a read-only adapter for stable Java 1.21.11 with exact DataVersion and Version.Id 4671. It does not enable 1.21.11 volume capture, placement or regeneration export. No release is published by the build scripts.

## Schema evidence

The version was checked against Mojang's [release announcement](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-21-11) and [official version metadata](https://piston-meta.mojang.com/v1/packages/718cd84b4912691fe5de829aab6876a4b7f6c5c4/1.21.11.json). The metadata SHA-1 is `718cd84b4912691fe5de829aab6876a4b7f6c5c4`. Its client JAR SHA-1 is `ba2df812c2d12e0219c489c4cd9a5e1f0760f5bd`; client mappings SHA-1 is `031a68bebf55d824f66d6573d8c752f0e1bf232a`. Downloaded bytes matched those hashes. The client version.json records stable 1.21.11 and world_version 4671.

Mapped client bytecode was inspected for `SerializableChunkData`, `StateHolder`, `PalettedContainer`, `PalettedContainerFactory` and `SimpleBitStorage`:

- Chunk roots contain xPos, yPos, zPos, Status and lowercase sections. yPos records the minimum section. Completed chunks use full status.
- Actual-height sections have byte Y and block_states; lighting-only sections may sit just outside those heights.
- Block palettes contain Name and optional Properties compounds. Compact strings and modern id/properties entries are not the 1.21.11 schema.
- Single-state palettes may omit data. Multi-state palettes use padded 64-bit words, with entries confined to a word; sections have 4,096 blocks.

The adapter checks these shapes in addition to metadata. Existing decoding checks retain property strings, signed 64-bit words, exact word counts and palette bounds. A separate 17-state fixture uses literal five-bit words across a word boundary, independent of the fixture encoder. Client binaries, mappings and game assets are not included in this repository or the application.

## Supported scope and uncertainty

The vanilla Overworld (-64–319), Nether (0–255) and End (0–255) are supported, including legacy region, DIM-1 and DIM1 layouts. Nether cavern/roof/cutaway behavior is unchanged. A missing section, malformed state or unreadable record stays visibly unknown; it is never silently converted to air. Custom heights, unknown chunk versions, snapshots, incomplete generation and unsupported compression remain explicit failures. Recognized older 4671 chunks can be viewed in a supported newer world; future chunks in a 4671 world remain unsupported.

The regression fixtures reproduce the verified storage schema, including water, foliage, roofs, nontrivial properties, air, lighting-only edge sections, legacy dimensions and feature metadata. They are generated format fixtures, not proof that the originally reported world renders correctly. Native UI checks cover map navigation, selection, protection and dimension switching. A real-world copy smoke test reports the actual version tested separately. Gameplay, native Windows execution and any unavailable original 1.21.11 save remain separate acceptance work.

Raw NBT, datapack configuration, template serialization, unknown-versus-air handling, placement rules, backup/confirmation requirements and export version gates are unchanged. Mods are outside this adapter's support scope.
