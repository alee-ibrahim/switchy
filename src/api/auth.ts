/**
 * Pluggable auth, toggled by env AUTH_MODE:
 *   off   (default) - no auth; for local dev / a trusted AV network
 *   proxy - trust identity headers set by an authenticating reverse proxy
 *           (Envoy Gateway OIDC SecurityPolicy, oauth2-proxy, ...) in front of the app.
 *           AUTH_USER_HEADER   (default x-auth-request-email)
 *           AUTH_GROUPS_HEADER (default x-auth-request-groups, comma separated)
 *           AUTH_ALLOWED_GROUPS (optional, comma separated: require one of these)
 *
 * Native OIDC can be added later as another mode in this file without
 * touching routes: everything goes through this one onRequest hook.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; groups: string[] } | null;
  }
}

export interface AuthConfig {
  mode: 'off' | 'proxy';
  userHeader: string;
  groupsHeader: string;
  allowedGroups: string[];
}

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode = (env.AUTH_MODE ?? 'off').toLowerCase();
  if (mode !== 'off' && mode !== 'proxy') throw new Error(`AUTH_MODE must be off or proxy, got "${mode}"`);
  return {
    mode,
    userHeader: (env.AUTH_USER_HEADER ?? 'x-auth-request-email').toLowerCase(),
    groupsHeader: (env.AUTH_GROUPS_HEADER ?? 'x-auth-request-groups').toLowerCase(),
    allowedGroups: (env.AUTH_ALLOWED_GROUPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

const PUBLIC = new Set(['/api/health']);

export function registerAuth(app: FastifyInstance, cfg: AuthConfig) {
  app.decorateRequest('user', null);
  if (cfg.mode === 'off') {
    app.log.warn('AUTH_MODE=off: the UI and API are open to anyone who can reach this port');
    return;
  }
  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    const url = req.url.split('?')[0]!;
    if (PUBLIC.has(url)) return;
    const user = req.headers[cfg.userHeader];
    if (typeof user !== 'string' || !user) return reply.code(401).send({ error: 'not authenticated' });
    const groupsRaw = req.headers[cfg.groupsHeader];
    const groups = (Array.isArray(groupsRaw) ? groupsRaw.join(',') : (groupsRaw ?? ''))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (cfg.allowedGroups.length && !groups.some((g) => cfg.allowedGroups.includes(g))) {
      return reply.code(403).send({ error: 'not in an allowed group' });
    }
    req.user = { id: user, groups };
  });
}
