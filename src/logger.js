// Tiny leveled logger — no dependency, readable output on Replit/Railway logs.
const ts = () => new Date().toISOString();
const fmt = (level, args) => [`[${ts()}] ${level}`, ...args];

export const log = {
  info: (...a) => console.log(...fmt('INFO ', a)),
  warn: (...a) => console.warn(...fmt('WARN ', a)),
  error: (...a) => console.error(...fmt('ERROR', a)),
  debug: (...a) => {
    if (process.env.DEBUG) console.log(...fmt('DEBUG', a));
  },
};
