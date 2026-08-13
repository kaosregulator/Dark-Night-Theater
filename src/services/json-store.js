import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../logger.js';

// Minimal debounced JSON file store. Good enough for a lightweight bot; the
// interface is deliberately tiny so it can be swapped for Redis/Postgres later
// without touching callers.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');

export class JsonStore {
  constructor(filename, initial = {}) {
    this.file = path.join(DATA_DIR, filename);
    this.data = initial;
    this._timer = null;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch (err) {
      log.warn(`Could not load ${this.file}:`, err.message);
    }
  }

  // Debounced persist so bursts of writes coalesce.
  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
      } catch (err) {
        log.warn(`Could not save ${this.file}:`, err.message);
      }
    }, 250);
  }
}
