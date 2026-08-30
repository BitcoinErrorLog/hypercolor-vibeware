import type { Database } from "./db.js";

export type SurfaceSeed = {
  id: string;
  owner: string;
  manifest: Record<string, unknown>;
};

export const SURFACE_SEEDS: readonly SurfaceSeed[] = [
  {
    id: "hc-chats-ui",
    owner: "hypercolor",
    manifest: {
      risk: 1,
      scope: {
        repositories: ["BitcoinErrorLog/hypercolor-web"],
        writable_paths: ["src/components/chats-page.tsx"],
        forbidden_paths: ["src/stores/inboxStore.ts", "src/lib/inbox.ts"],
      },
      evidence: {
        allowed: ["app.route.viewed", "app.chat.empty_state", "app.error.coarse"],
        forbidden: [
          "private_message_body",
          "raw_auth_token",
          "seed_material",
          "payment_details",
          "recovery_code",
          "attachment_bytes",
        ],
      },
      exposure: {
        allowed_cohorts: ["experimental", "internal", "opted_in"],
        max_initial_percent: 10,
        requires_human_for_percent_over: 25,
      },
      selection: {
        primary_metric: "empty_state_escape_rate",
        guardrails: ["app.error.coarse", "send_settle_failed_rate"],
        minimum_exposure_hours: 48,
      },
      autonomy: { max_level: "expose", auto_merge: false, auto_promote: false },
      kill_switch: { flag: "hc-chats-ui-vibeware-enabled" },
    },
  },
  {
    id: "hc-thread-ui",
    owner: "hypercolor",
    manifest: {
      risk: 1,
      scope: {
        repositories: ["BitcoinErrorLog/hypercolor-web"],
        writable_paths: [
          "src/components/thread-view.tsx",
          "src/components/composer.tsx",
          "src/components/message-bubble.tsx",
        ],
        forbidden_paths: ["src/components/attachment-bubble.tsx"],
      },
      evidence: {
        allowed: ["app.thread.send_settled", "app.error.coarse"],
        forbidden: [
          "private_message_body",
          "raw_auth_token",
          "seed_material",
          "payment_details",
          "recovery_code",
          "attachment_bytes",
        ],
      },
      exposure: {
        allowed_cohorts: ["experimental", "internal", "opted_in"],
        max_initial_percent: 10,
        requires_human_for_percent_over: 25,
      },
      selection: {
        primary_metric: "send_settle_success",
        guardrails: ["app.error.coarse", "send_settle_failed_rate"],
        minimum_exposure_hours: 48,
      },
      autonomy: { max_level: "expose", auto_merge: false, auto_promote: false },
      kill_switch: { flag: "hc-thread-ui-vibeware-enabled" },
    },
  },
  {
    id: "hc-onboarding-ui",
    owner: "hypercolor",
    manifest: {
      risk: 1,
      scope: {
        repositories: ["BitcoinErrorLog/hypercolor-web"],
        writable_paths: [
          "src/components/welcome-page.tsx",
          "src/components/enable-page.tsx",
          "src/components/auth-qr.tsx",
          "src/components/auth-url-panel.tsx",
        ],
        forbidden_paths: ["src/services/RingConnect.ts", "src/services/link/session.ts"],
      },
      evidence: {
        allowed: ["app.onboarding.state", "app.onboarding.abandoned", "app.pwa.installed"],
        forbidden: [
          "private_message_body",
          "raw_auth_token",
          "seed_material",
          "payment_details",
          "recovery_code",
          "attachment_bytes",
        ],
      },
      exposure: {
        allowed_cohorts: ["experimental", "internal", "opted_in"],
        max_initial_percent: 10,
        requires_human_for_percent_over: 25,
      },
      selection: {
        primary_metric: "onboarding_completion_rate",
        guardrails: ["app.error.coarse", "onboarding_abandoned_rate"],
        minimum_exposure_hours: 48,
      },
      autonomy: { max_level: "expose", auto_merge: false, auto_promote: false },
      kill_switch: { flag: "hc-onboarding-ui-vibeware-enabled" },
    },
  },
];

export async function seedSurfaces(db: Database): Promise<void> {
  for (const surface of SURFACE_SEEDS) {
    await db.query(
      `INSERT INTO vibeware_surfaces (id, manifest, owner)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO NOTHING`,
      [surface.id, JSON.stringify(surface.manifest), surface.owner],
    );
  }
}
