import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// Resolve the install once from this module, never from the caller's cwd.
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const stateRoot = path.resolve(process.env.HARNESS_STATE_DIR || path.join(os.homedir(), '.local/state/opencode-subscription-harness'));
export const managedConfigRoot = path.join(stateRoot, 'config');
export const statePath = (...parts) => path.join(stateRoot, ...parts);
export const configuredPython = process.env.HARNESS_PYTHON || 'python3';
export const configuredCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
