import path from 'node:path';
import fs from 'node:fs';
import { makeWorld } from '../tests/fixtures.js';
const folder = path.resolve(process.argv[2] || 'work/synthetic-demo');
if (fs.existsSync(folder)) throw new Error(`Refusing to overwrite existing demo: ${folder}`);
makeWorld(folder, { demo: true });
fs.writeFileSync(path.join(folder, 'SYNTHETIC-FIXTURE.txt'), 'WorldRenew UI test fixture. Not a playable Minecraft world. DataVersion 999999 is deliberately synthetic.');
console.log(`Synthetic demo created at ${folder}\nNot a playable Minecraft save. Run npm start -- --world="${folder}" and choose Open world folder.`);
