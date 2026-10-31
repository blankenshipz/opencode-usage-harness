import fs from 'node:fs/promises';
import path from 'node:path';
import { managedConfigRoot } from './paths.mjs';

// Operator-owned evidence for the exceptional case where a managed child must
// write outside its workspace.  This module deliberately has no tool surface.
const grantFileName = 'external-write-grants.json';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`task-dispatch: external write grant ${message}`); };

async function noSymlink(file, { required = true } = {}) {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (!required && error.code === 'ENOENT') return; throw error; }
  // macOS exposes /var and /tmp as OS-owned aliases. They are normalized by
  // realpath below; arbitrary descendants remain forbidden.
  if (stat.isSymbolicLink() && !new Set(['/var','/tmp','/etc']).has(file)) fail('has an unsafe symlink');
  return stat;
}
async function safeConfigFile(file, configRoot = managedConfigRoot) {
  const root = path.resolve(configRoot);
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('is outside managed config');
  let current = path.parse(root).root;
  for (const piece of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece); await noSymlink(current);
  }
  const stat = await noSymlink(file);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) fail('must be an owner-only 0600 regular file');
}

// Resolve a path even if its final directories do not exist. Existing path
// components are lstat'ed (rather than followed) so a later create cannot use
// a hidden symlink to leave the granted tree.
export async function canonicalExternalPath(destination) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || /\0/.test(destination)) fail('destination must be an absolute literal path');
  const resolved = path.resolve(destination);
  const parsed = path.parse(resolved), pieces = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root, firstMissing = pieces.length;
  for (let index=0; index<pieces.length; index++) {
    current = path.join(current, pieces[index]);
    try { await noSymlink(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      firstMissing=index; break;
    }
  }
  const ancestor = path.join(parsed.root, ...pieces.slice(0, firstMissing));
  const canonical = await fs.realpath(ancestor);
  return path.join(canonical, ...pieces.slice(firstMissing));
}
const contains = (root, item) => item === root || item.startsWith(`${root}${path.sep}`);
const sameStrings = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length
  && new Set(left).size === left.length && new Set(right).size === right.length && left.every(value => right.includes(value));

function validGrant(grant) {
  const keys = ['version','grantID','workspace','rootID','parentID','childID','taskId','workKey','intentRevision','checkIds','agent','operation','externalRoot','expiresAt','revoked'];
  if (!isObject(grant) || Object.keys(grant).some(key => !keys.includes(key)) || grant.version !== 1
    || !['grantID','workspace','rootID','parentID','childID','taskId','workKey','agent','externalRoot','expiresAt'].every(key => typeof grant[key] === 'string' && grant[key])
    || !Number.isInteger(grant.intentRevision) || !Array.isArray(grant.checkIds) || !grant.checkIds.every(value => typeof value === 'string' && value)
    || grant.operation !== 'implement' || typeof grant.revoked !== 'boolean') fail('is invalid');
  return grant;
}
async function loadGrant(grantID, { grantPath = path.join(managedConfigRoot, grantFileName), configRoot } = {}) {
  if (typeof grantID !== 'string' || !grantID) fail('ID is required');
  await safeConfigFile(grantPath, configRoot);
  let document;
  try { document = JSON.parse(await fs.readFile(grantPath, 'utf8')); } catch { fail('file is invalid JSON'); }
  if (!isObject(document) || document.version !== 1 || !Array.isArray(document.grants) || Object.keys(document).some(key => !['version','grants'].includes(key))) fail('file is invalid');
  const matches = document.grants.filter(grant => grant?.grantID === grantID);
  if (matches.length !== 1) fail('was not found');
  return validGrant(matches[0]);
}

export async function authorizeExternalWrites({ grantID, workspace, rootID, parentID, childID, taskId, workKey, intentRevision, checkIds, agent, operation, destinations, now = Date.now, grantPath, configRoot } = {}) {
  const grant = await loadGrant(grantID, { grantPath, configRoot });
  if (grant.revoked) fail('is revoked');
  if (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now()) fail('is expired');
  const canonicalWorkspace = await canonicalExternalPath(workspace);
  const externalRoot = await canonicalExternalPath(grant.externalRoot);
  if (grant.workspace !== canonicalWorkspace || grant.rootID !== rootID || grant.parentID !== parentID || grant.childID !== childID
    || grant.taskId !== taskId || grant.workKey !== workKey || grant.intentRevision !== intentRevision || !sameStrings(grant.checkIds, checkIds)
    || grant.agent !== agent || grant.operation !== operation) fail('does not match this existing child assignment');
  if (!childID) fail('requires an existing child');
  const canonicalDestinations = await Promise.all(destinations.map(canonicalExternalPath));
  if (!canonicalDestinations.length || canonicalDestinations.some(destination => !contains(externalRoot, destination))) fail('does not cover the requested destination');
  return { grantID: grant.grantID, externalRoot, destinations: canonicalDestinations };
}
