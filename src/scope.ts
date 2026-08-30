export const GLOBAL_FORBIDDEN_PATHS: readonly string[] = [
  "src/services/link/session.ts",
  "src/services/RingConnect.ts",
  "src/services/ringChannelId.ts",
  "src/lib/app-origin.ts",
  "src/lib/capabilities.ts",
  "src/services/link/PaykitLinkWeb.ts",
  "src/services/link/LinkService.ts",
  "src/services/link/provisionReceiver.ts",
  "src/services/link/wotGate.ts",
  "src/services/link/inboundEnvelope.ts",
  "src/services/KeyStore.ts",
  "src/services/attachments/xchacha.ts",
  "src/services/backup/crypto.ts",
  "vendor/paykit-wasm/**",
  "src/types/**",
  "src/services/group/applyGroupInbound.ts",
  "src/services/attachments/applyAttachmentInbound.ts",
  "src/lib/group-invites.ts",
  "src/services/payments/**",
  "vibeware.yaml",
  "scripts/check-vibeware*",
  "scripts/vibeware-evidence.mjs",
  ".github/**",
  "src/components/ring-callback-page.tsx",
  "src/components/session-bootstrap.tsx",
  "src/components/pwa-register.tsx",
  "src/components/enable-messaging-cta.tsx",
  "src/services/backup/**",
  "src/services/link/stagingSignup.ts",
  "src/services/link/dmHarness.ts",
  "src/services/link/groupHarness.ts",
  "src/services/link/ownerRoundtrip.ts",
  "src/services/onboarding/enableActions.tsx",
  "src/services/onboarding/welcomeActions.tsx",
  "src/services/thread/threadActions.tsx",
  "src/services/chats/chatsPageHost.tsx",
  "src/components/auth-url-actions.tsx",
  "src/hooks/useThread.ts",
  "src/hooks/useAuthUrl.ts",
  "src/hooks/usePaykitConnect.ts",
  "src/hooks/useInbox.ts",
  "src/hooks/useChannel.ts",
  "src/hooks/useSignOut.ts",
  "package.json",
  "package-lock.json",
  "scripts/copy-sqlite-wasm.mjs",
  "src/services/contacts/addManualContact.ts",
  "src/services/group/GroupService.ts",
  "src/services/StorageService.ts",
  "src/stores/inboxStore.ts",
];

const FORBIDDEN_BASENAMES = new Set([
  "session.ts",
  "KeyStore.ts",
  "vibeware.yaml",
]);

export function normalizePath(path: string): string | null {
  const trimmed = path.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed.startsWith("/")) return null;
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts.join("/");
}

export function pathMatchesRule(path: string, rule: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized) return false;
  const r = rule.replaceAll("\\", "/");
  if (r.endsWith("/**")) {
    const prefix = r.slice(0, -3);
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  }
  if (r.endsWith("*") && !r.includes("**")) {
    const prefix = r.slice(0, -1);
    const slash = prefix.lastIndexOf("/");
    const dir = slash === -1 ? "" : prefix.slice(0, slash + 1);
    const filePrefix = slash === -1 ? prefix : prefix.slice(slash + 1);
    if (dir && !normalized.startsWith(dir)) return false;
    const name = normalized.slice(dir.length);
    return name.startsWith(filePrefix) && !name.includes("/");
  }
  return normalized === r;
}

export function isForbiddenPath(path: string, surfaceForbidden: readonly string[] = []): boolean {
  const normalized = normalizePath(path);
  if (!normalized) return true;
  const slash = normalized.lastIndexOf("/");
  const basename = slash === -1 ? normalized : normalized.slice(slash + 1);
  if (FORBIDDEN_BASENAMES.has(basename)) return true;
  const rules = [...GLOBAL_FORBIDDEN_PATHS, ...surfaceForbidden];
  return rules.some((rule) => pathMatchesRule(normalized, rule));
}

export function isWritablePath(path: string, writablePaths: readonly string[]): boolean {
  const normalized = normalizePath(path);
  if (!normalized) return false;
  return writablePaths.some((rule) => pathMatchesRule(normalized, rule) || normalizePath(rule) === normalized);
}

export function unionForbiddenPaths(surfaceForbidden: readonly string[]): string[] {
  return [...new Set([...GLOBAL_FORBIDDEN_PATHS, ...surfaceForbidden])];
}

export function scopeTouchesForbidden(
  suspectedScope: readonly string[],
  surfaceForbidden: readonly string[] = [],
): boolean {
  return suspectedScope.some((path) => isForbiddenPath(path, surfaceForbidden));
}

export function scopeWithinWritable(
  suspectedScope: readonly string[],
  writablePaths: readonly string[],
): boolean {
  return suspectedScope.every((path) => isWritablePath(path, writablePaths));
}
