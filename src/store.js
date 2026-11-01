// Persistencia simple en un archivo JSON (volumen de Docker). Escritura atómica: tmp + rename.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const empty = () => ({ conversations: [], orders: [], seq: { conv: 0, msg: 0, order: 0 } });

let db = empty();
try {
  db = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch (err) {
  if (err.code !== 'ENOENT') console.error('[store] db.json ilegible, se arranca vacío:', err.message);
}

let pending = null;
function save() {
  // Agrupa escrituras seguidas en una sola.
  if (pending) return;
  pending = setImmediate(() => {
    pending = null;
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, DB_FILE);
  });
}

function nextId(kind) {
  db.seq[kind] = (db.seq[kind] || 0) + 1;
  return db.seq[kind];
}

function reset() {
  db = empty();
  save();
}

module.exports = { get db() { return db; }, save, nextId, reset };
