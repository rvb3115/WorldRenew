import { inspectWorld } from '../engine/world.js';
if (!process.argv[2]) { console.error('Usage: npm run inspect -- "/path/to/world"'); process.exit(1); }
try { console.log(JSON.stringify(inspectWorld(process.argv[2]), null, 2)); }
catch (error) { console.error(`${error.code || 'ERROR'}: ${error.message}`); process.exitCode = 1; }
