import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { getSettings } from '../services/settings-store.js';

// Global bot admins (from ADMIN_USER_IDS) can always run management commands.
export function isGlobalAdmin(userId) {
  return config.app.adminUserIds.includes(userId);
}

// Server owner or Administrator permission — always allowed to host/manage.
function isServerAdmin(member) {
  if (!member) return false;
  if (member.guild?.ownerId === member.id) return true;
  return member.permissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

// Who may host/control the clan movie in this guild.
export function canHost(member) {
  if (!member) return false;
  if (isGlobalAdmin(member.id) || isServerAdmin(member)) return true;
  const s = getSettings(member.guild.id);
  if (s.hostRoleId && member.roles.cache.has(s.hostRoleId)) return true;
  return false;
}

// Who may change the clan movie / manage the library for this guild.
export function canManage(member) {
  if (!member) return false;
  if (isGlobalAdmin(member.id) || isServerAdmin(member)) return true;
  const s = getSettings(member.guild.id);
  if (s.managerRoleId && member.roles.cache.has(s.managerRoleId)) return true;
  return false;
}
