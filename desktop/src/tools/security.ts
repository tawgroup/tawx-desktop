import { basename } from 'node:path';

const MAX_COMMAND_BYTES = 32_000;
const MAX_ARGUMENTS = 256;
const REDACTED = '[REDACTED]';

const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|credentials?|authorization|auth|cookie|private[_-]?key|database[_-]?url|connection[_-]?(?:string|uri)|dsn)(?:$|[_-])/i;
const SECRET_NAME = 'api[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|auth(?:orization)?|password|passwd|secret|cookie|private[_-]?key|database[_-]?url|connection[_-]?(?:string|uri)|dsn';
const QUOTED_SECRET_ASSIGNMENT = new RegExp(`(["']?)(${SECRET_NAME})\\1(\\s*(?:=|:)\\s*)(["'])(?:\\\\.|[^\\r\\n])*?\\4`, 'gi');
const UNQUOTED_SECRET_ASSIGNMENT = new RegExp(`(["']?)(${SECRET_NAME})\\1(\\s*(?:=|:)\\s*)[^\\s,"';]+`, 'gi');
const PRIVATE_KEY = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const WELL_KNOWN_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;

const FORBIDDEN_EXECUTABLES: Readonly<Record<string, true>> = {
  bash: true,
  cmd: true,
  csh: true,
  dash: true,
  diskutil: true,
  doas: true,
  env: true,
  fish: true,
  git: true,
  ksh: true,
  mkfs: true,
  mount: true,
  osascript: true,
  powershell: true,
  pwsh: true,
  reboot: true,
  scp: true,
  sftp: true,
  sh: true,
  shutdown: true,
  ssh: true,
  su: true,
  sudo: true,
  tcsh: true,
  umount: true,
  xargs: true,
  zsh: true,
};

const INLINE_INTERPRETER_FLAGS: Readonly<Record<string, Readonly<Record<string, true>>>> = {
  bun: { '-e': true, '--eval': true, '-p': true, '--print': true },
  node: { '-e': true, '--eval': true, '-p': true, '--print': true },
  perl: { '-e': true, '-E': true },
  php: { '-r': true },
  python: { '-c': true },
  python3: { '-c': true },
  ruby: { '-e': true },
};

export class CommandSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandSafetyError';
  }
}

export interface ParsedCommand {
  executable: string;
  args: string[];
}

/** Redacts common credentials without logging the value that triggered the match. */
export function redactText(value: string): string {
  return value
    .replace(PRIVATE_KEY, REDACTED)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(BEARER_TOKEN, `$1${REDACTED}`)
    .replace(WELL_KNOWN_TOKEN, REDACTED)
    .replace(QUOTED_SECRET_ASSIGNMENT, `$1$2$1$3$4${REDACTED}$4`)
    .replace(UNQUOTED_SECRET_ASSIGNMENT, `$1$2$1$3${REDACTED}`);
}

/** Recursively produces an audit-safe copy. Secret-named fields are never traversed. */
export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(child, seen);
  }
  return output;
}

/**
 * Parses one command without invoking a shell. Control operators, substitutions,
 * nested shells, direct git, and inline interpreter programs are rejected.
 */
export function parseCommand(command: string): ParsedCommand {
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    throw new CommandSafetyError(`command exceeds the ${MAX_COMMAND_BYTES} byte limit`);
  }
  if (command.includes('\0')) throw new CommandSafetyError('command contains a null byte');

  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: 'single' | 'double' | null = null;

  const finishToken = () => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = '';
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;

    if (quote === 'single') {
      if (character === "'") quote = null;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (quote === 'double') {
      if (character === '"') {
        quote = null;
      } else if (character === '\\') {
        index += 1;
        if (index >= command.length) throw new CommandSafetyError('command ends with an escape');
        token += command[index]!;
      } else {
        if (character === '`' || (character === '$' && command[index + 1] === '(')) {
          throw new CommandSafetyError('command substitution is not allowed');
        }
        token += character;
      }
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (character === '\n' || character === '\r') {
        throw new CommandSafetyError('multi-line commands are not allowed');
      }
      finishToken();
      continue;
    }
    if (character === "'") {
      quote = 'single';
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      quote = 'double';
      tokenStarted = true;
      continue;
    }
    if (character === '\\') {
      index += 1;
      if (index >= command.length) throw new CommandSafetyError('command ends with an escape');
      token += command[index]!;
      tokenStarted = true;
      continue;
    }
    if (';&|<>`'.includes(character) || (character === '$' && command[index + 1] === '(')) {
      throw new CommandSafetyError('shell control operators and substitutions are not allowed');
    }
    token += character;
    tokenStarted = true;
  }

  if (quote) throw new CommandSafetyError('command contains an unterminated quote');
  finishToken();
  if (tokens.length === 0) throw new CommandSafetyError('command is empty');
  if (tokens.length > MAX_ARGUMENTS) {
    throw new CommandSafetyError(`command exceeds the ${MAX_ARGUMENTS} argument limit`);
  }

  const executable = tokens[0]!;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(executable)) {
    throw new CommandSafetyError('inline environment assignments are not allowed');
  }

  const commandName = basename(executable).toLowerCase();
  if (FORBIDDEN_EXECUTABLES[commandName]) {
    const reason = commandName === 'git'
      ? 'direct git commands are disabled; use the guarded git tools'
      : `${commandName} is not allowed by command safety policy`;
    throw new CommandSafetyError(reason);
  }

  const args = tokens.slice(1);
  const inlineFlags = INLINE_INTERPRETER_FLAGS[commandName];
  if (inlineFlags && args.some((arg) => (
    inlineFlags[arg] === true
    || Object.keys(inlineFlags).some((flag) => arg.startsWith(`${flag}=`))
  ))) {
    throw new CommandSafetyError(`inline ${commandName} programs are not allowed`);
  }
  if (args.some((arg) => FORBIDDEN_EXECUTABLES[basename(arg).toLowerCase()] === true)) {
    throw new CommandSafetyError('nesting a blocked executable is not allowed');
  }

  return { executable, args };
}

/** Removes inherited credentials and process-injection variables from child commands. */
export function commandEnvironment(root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SECRET_KEY.test(key)) continue;
    if (/^(?:BASH_ENV|CDPATH|ENV|GIT_|LD_|DYLD_|NODE_OPTIONS|SHELLOPTS|SSH_)/i.test(key)) continue;
    environment[key] = value;
  }
  environment.PWD = root;
  environment.OLDPWD = root;
  return environment;
}
