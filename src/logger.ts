export type LogLevel = 'quiet' | 'normal' | 'verbose';

// 0 = quiet (errors only), 1 = normal (info + errors), 2 = verbose (all)
let currentLevel = 1;

export function setLogLevel(level: LogLevel) {
  switch (level) {
    case 'quiet':
      currentLevel = 0;
      break;
    case 'normal':
      currentLevel = 1;
      break;
    case 'verbose':
      currentLevel = 2;
      break;
  }
}

const log = {
  debug(...args: unknown[]) {
    if (currentLevel >= 2) {
      console.log(...args);
    }
  },
  info(...args: unknown[]) {
    if (currentLevel >= 1) {
      console.log(...args);
    }
  },
  error(...args: unknown[]) {
    console.error(...args);
  },
};

export default log;
