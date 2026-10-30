import type { ProjectId } from "@t3tools/contracts";

export function boatSetupPrompt(projectId: ProjectId): string {
  return `Set up this project for development in Boat and show me its working preview.
Inspect the actual project and its instructions first. Use the existing provider, permissions and Boat tools. Configure suitable install and dev commands for this project's stack, start or resume its Boat environment, verify that the application works there, and reveal its preview in this thread. For an empty or ambiguous project, ask me what I want to build instead of inventing an application. For a project without a web UI, choose an appropriate useful development surface with me.
Keep project ${projectId} and this thread. Reuse Boat requestId boat-setup:${projectId} after interrupted or uncertain operations; do not create duplicate machines or threads. Crew stops the environment when its last agent finishes and also enforces its timeout; resume the same environment for further requested work. Use the configured CI only within its authorized scope. Preserve existing workflows; do not enable CI, publish, deploy or release without my instruction. Keep credentials in their existing private stores, never in prompts, logs or source. Report concrete failures in this thread so we can continue here.`;
}
