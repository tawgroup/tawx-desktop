import { access, chmod, copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Copies the bundled standalone config into the user's config directory on first run. */
export async function ensureConfig(bundledConfigPath: string): Promise<string> {
  const configDir = process.env.TAWX_DESKTOP_HOME ?? join(homedir(), 'tawx-desktop');
  const configPath = process.env.TAWX_DESKTOP_CONFIG ?? join(configDir, 'config.yaml');

  try {
    await access(configPath);
    return configPath;
  } catch {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await copyFile(bundledConfigPath, configPath);
    await chmod(configPath, 0o600);
    return configPath;
  }
}
