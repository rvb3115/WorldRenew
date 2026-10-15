# Vanilla Java and datapack configuration

WorldRenew targets vanilla Java saves, including saves that use vanilla datapacks or experimental feature flags. It does not add mod support, a Minecraft registry emulator or a seed-based terrain generator. Actual saved chunk data supplies map and build previews; missing or unsupported data is explicitly labeled.

## Evidence rather than inferred history

Inspection reports recorded `enabled_features`, `removed_features`, `DataPacks.Enabled` and `DataPacks.Disabled`, plus recognized generation settings. Missing or malformed lists are shown as unknown/unrecognized. `WasModded` is not used to detect experiments. Current or absent flags cannot establish whether a world used experiments in the past.

Generation metadata is read from `data/minecraft/world_gen_settings.dat` when present, falling back to legacy `Data.WorldGenSettings` in `level.dat`. Both `generate_structures` and legacy `generate_features` are recognized. Generator settings IDs such as `minecraft:amplified` are reported from saved evidence; inline/custom settings are not interpreted as known presets.

These decisions follow Mojang's primary documentation:

- [Java 26.1 changes](https://feedback.minecraft.net/hc/en-us/articles/44551668333837-Minecraft-Java-Edition-26-1) moved world-generation settings out of level.dat and renamed the structure-generation field.
- [Snapshot 22w42a](https://feedback.minecraft.net/hc/en-us/articles/9994475500301-Minecraft-Java-Edition-Snapshot-22w42a) documents feature flags and their relationship to datapacks and saved world state.
- [Snapshot 23w12a](https://www.minecraft.net/en-us/article/minecraft-snapshot-23w12a) documents removal of a former experiment flag as its features became ordinary game content. A flag list is therefore not a complete experiment history.

## Operation boundaries

Experimental flags are warnings/evidence, not a blanket rejection. Read-only inspection, supported terrain decoding, raw archives, verified byte copies, and supported copied-world operations remain available. Specific version/schema, block, entity, POI, scheduled-update and dimension restrictions still apply. Unknown custom dimension heights and unsupported schemas are disclosed rather than guessed. Preserving a datapack does not certify that its behavior will work after an edit.

World backups and result copies retain level.dat, generation metadata and datapack files byte-for-byte. Placement keeps destination configuration unchanged and reports differences from recorded template provenance. Templates contain raw selected chunk-store records and optional configuration provenance, but do not bundle, install, enable or disable datapacks. Old templates without provenance still open and receive an explicit notice.

Placement reviews fingerprint destination configuration and datapack contents, so changes require another review. This check is bounded to 10,000 entries, 32 directory levels, 64 MiB per file and 256 MiB total. Exceeding those limits blocks that rewrite review with a specific message; it does not classify the world as modded or disable read-only inspection/raw capture. Archive capture does not load datapack payloads.

Regeneration continues to remove coordinated records only from an owned copy using the exact 26.3 / 5023 namespaced Overworld adapter. Minecraft performs subsequent generation when the user opens the copy, using its preserved world settings and datapacks. Block placement still uses the separate exact 26.2 / 4903 adapter. No version gate is widened by flags or decoder support.

`tests/world-configuration.test.js` covers split generation settings, active/removed flags, unknown history, byte-exact configuration preservation through placement and regeneration, bounded fingerprinting, changed-pack review invalidation and map rendering with flags enabled. Tests are synthetic; native Windows and Minecraft gameplay acceptance remain separate checks.
