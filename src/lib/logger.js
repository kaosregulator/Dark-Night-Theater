// Pino-compatible shim over the theater bot logger so ported DN-cards /emoji
// code can keep its logger.info({ ctx }, "msg") call shape.
import { log } from "../logger.js";

function emit(level, args) {
  if (typeof args[0] === "string") {
    log[level](...args);
    return;
  }
  if (args.length >= 2 && typeof args[1] === "string") {
    const [ctx, msg, ...rest] = args;
    log[level](msg, ctx, ...rest);
    return;
  }
  log[level](...args);
}

export const logger = {
  info: (...a) => emit("info", a),
  warn: (...a) => emit("warn", a),
  error: (...a) => emit("error", a),
  debug: (...a) => emit("debug", a),
  child: () => logger,
};
