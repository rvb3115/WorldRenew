# Portable local templates

Templates are `.wrbuild` files saved in the persistent WorldRenew profile's `templates` directory. The Templates dialog shows the full local path and provides Open Templates Folder, Import, Open and Export. No account, hosted storage or sync service is involved.

- Windows default: `%APPDATA%\WorldRenew\templates`
- macOS default: `~/Library/Application Support/WorldRenew/templates`
- `WORLDRENEW_USER_DATA` overrides the profile for tests or custom installations; retain the same override when upgrading.

Load a complete 3D selection, give it a name and choose **Save to local templates**. **Save & export build file** also leaves a verified local copy. Opening an external build file imports it into the library. Existing external files and saved selection-boundary plans remain untouched.

To move a template, export or copy its `.wrbuild` file to the other device, then Import or drop the file into WorldRenew. No original world or absolute source path is required. Windows and Mac use the same format, raw NBT records and validation rules. Local copies remain after the source world, downloaded file or other device disappears.

Names are sanitized for both platforms; duplicates become `Name (2).wrbuild`, etc. Publication uses an exclusive file link, and an existing export target is rejected. Imports are byte-exact copies; no palette/property/air normalization is written back. Every import/open/export validates the magic, checksum, bounded decompression, dimensions, records and palette data. Limits remain 64 MiB on disk, 192 MiB expanded JSON and 128 MiB raw chunk records, with the existing selection-volume limit. Symbolic-link library entries are rejected. The paginated library lists at most 10,000 directory entries and validates content on open instead of decoding all files at startup.

Files preserve the selection plus full supporting terrain/entity/POI chunks, which can include surrounding blocks and inventories. Review this before sharing. Preservation does not authorize placing unsupported contents; version, dependency, protection, review and copied-world export gates remain in force. Templates are never saved inside a Minecraft world.

Tests cover duplicate names, exact copying, cross-directory transfer without the original source, Windows-safe names, traversal/symlink rejection, corrupt/oversized imports, no-overwrite exports, source-world directory safety and pagination. `npm run test:templates` tests real Electron File drag/drop, named saves, cold-start reopening, import/export and folder access using disposable fixtures.
