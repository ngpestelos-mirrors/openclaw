// Parses the connectable command that `crabbox ssh --show-secret` prints.
export type CrabboxSandboxEndpoint = {
  target: string;
  identityFile?: string;
  knownHostsFile?: string;
};

/** Splits the single-quoted POSIX command line that `crabbox ssh` prints. */
function splitShellQuotedLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inSingle) {
      if (char === "'") {
        inSingle = false;
      } else {
        current += char;
      }
      continue;
    }
    if (inDouble) {
      if (char === '"') {
        inDouble = false;
      } else if (char === "\\" && index + 1 < line.length) {
        index += 1;
        current += line[index];
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'") {
      inSingle = true;
      hasToken = true;
    } else if (char === '"') {
      inDouble = true;
      hasToken = true;
    } else if (char === "\\" && index + 1 < line.length) {
      index += 1;
      current += line[index];
      hasToken = true;
    } else if (char === " " || char === "\t") {
      if (hasToken) {
        tokens.push(current);
      }
      current = "";
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (inSingle || inDouble) {
    throw new Error("unterminated quote in ssh command");
  }
  if (hasToken) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Parses the `ssh ... user@host` command printed by `crabbox ssh --show-secret`
 * into SSH backend settings. The user may be a short-lived provider token, so
 * the target is never logged.
 */
export function parseCrabboxSshCommand(stdout: string): CrabboxSandboxEndpoint {
  const line = stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .findLast((entry) => entry.startsWith("ssh ") || entry.startsWith("'ssh'"));
  if (!line) {
    throw new Error("crabbox ssh did not print an ssh command");
  }
  const tokens = splitShellQuotedLine(line);
  if (tokens[0] !== "ssh") {
    throw new Error("crabbox ssh printed an unexpected command");
  }
  let port = 22;
  let identityFile: string | undefined;
  let knownHostsFile: string | undefined;
  let destination: string | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    if (token === "-p" || token === "-i" || token === "-o" || token === "-F" || token === "-l") {
      const value = tokens[index + 1];
      index += 1;
      if (value === undefined) {
        throw new Error(`crabbox ssh printed ${token} without a value`);
      }
      if (token === "-p") {
        port = Number(value);
      } else if (token === "-i") {
        identityFile = value;
      } else if (token === "-o") {
        const [key, ...rest] = value.split("=");
        if (key === "UserKnownHostsFile") {
          knownHostsFile = rest.join("=");
        }
      } else if (token === "-F") {
        throw new Error(
          "crabbox ssh printed a config-file command; a direct ssh destination is required",
        );
      }
      continue;
    }
    if (token.startsWith("-")) {
      // Flags without values (for example -T) do not affect the endpoint.
      continue;
    }
    destination = token;
    break;
  }
  if (!destination || !destination.includes("@")) {
    throw new Error("crabbox ssh did not print a user@host destination");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("crabbox ssh printed an invalid port");
  }
  const at = destination.lastIndexOf("@");
  const user = destination.slice(0, at);
  const host = destination.slice(at + 1);
  if (!user || !host) {
    throw new Error("crabbox ssh printed an incomplete destination");
  }
  const bracketedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return {
    target: `${user}@${bracketedHost}:${port}`,
    ...(identityFile ? { identityFile } : {}),
    ...(knownHostsFile && knownHostsFile !== "/dev/null" ? { knownHostsFile } : {}),
  };
}
